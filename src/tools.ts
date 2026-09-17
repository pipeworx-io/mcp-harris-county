/**
 * Harris County (TX) civil-docket tools — read the mirror over PostgREST.
 * Fleet #1085. Mirrors the `mcps/gov-auctions` shape: stateless, credentials
 * injected by the gateway (`injectSupabase: true`, `supabaseEnv: 'DOCKETS'`).
 *
 * The rows come from `supabase/migrations/dockets_004_harris_civil.sql`, loaded
 * by `POST /admin/harris_civil_sync` on registry-api.
 *
 * GRAIN, and it is the trap this pack has to keep saying out loud: the weekly
 * index the cases table is built from is a ROLLING ACTIVITY WINDOW, not a
 * complete history. The 20260829 file covers 20260720-0829. So a company
 * absent from these results has no case ACTIVE IN THE WINDOWS WE HAVE
 * INGESTED — that is not the same claim as "has never been sued in Harris
 * County", and every response says so rather than leaving the caller to assume
 * the stronger one.
 */

// NOTHING IS IMPORTED FROM '@pipeworx/shared' IN THIS FILE, ON PURPOSE.
//
// publish-pack.sh builds the standalone npm package by INLINING the resolved
// @pipeworx/shared helpers into `src/index.ts` — and only index.ts. Sibling
// files are copied verbatim, so a sibling that imports shared keeps an import
// of a workspace package the published repo does not have, and the standalone
// typecheck dies with:
//
//   src/tools.ts(18,36): error TS2307: Cannot find module '@pipeworx/shared'
//
// This pack's whole implementation lives here rather than in index.ts, so it
// was the one published pack that tripped it (fleet #2131). Exactly two packs
// catalogue-wide have the shape; the other is the private `fleet` pack, which
// is never published.
//
// So the two things this file needed from shared now arrive from index.ts:
//   - the TYPE, restated below as a local structural type. index.ts still
//     asserts the real `satisfies McpToolExport`, so the true contract is
//     enforced at the boundary and a drift in shared still fails the build.
//   - the RUNTIME helper, `fetchWithTimeout`, injected as `createPack(pwFetch)`.
//     Injected rather than re-implemented: fleet #685 requires every fetch in a
//     pack to be bounded by the shared timeout, and re-declaring the helper here
//     would quietly opt this pack out of that policy the next time it changed.
//
// The durable fix is publisher-side — emit a generated `src/_pipeworx-shared.ts`
// that siblings can import — and is deliberately NOT done here: it reshapes all
// 1,584 bundles and was not worth landing mid-sweep.

/** A bounded fetch. Supplied by index.ts, which is where shared gets inlined. */
type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The subset of `McpToolDefinition` this file declares. Restated locally so the
 * tool literals below still get contextual typing — `type: 'object'` has to be
 * the literal type, not `string` — without importing from shared.
 */
type ToolDef = {
  name: string;
  description: string;
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  outputSchema?: Record<string, unknown>;
};

interface SupabaseConfig {
  url: string;
  key: string;
  /** Carried on the config so every query goes through the injected fetch. */
  fetch: Fetcher;
}

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await cfg.fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`data query ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Exact count via the Content-Range header.
 *
 * RETURNS null, NEVER 0, WHEN THE COUNT DID NOT RUN — the gov-auctions lesson
 * (fleet #1081): a swallowed 500 that returns 0 tells a caller a company has
 * no cases when the truth is that we failed to look.
 */
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number | null> {
  const res = await cfg.fetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/**
 * Company names into safe substring tokens.
 *
 * Commas, parentheses and `.` are PostgREST's own filter syntax, and party
 * names are full of them (`KROGER TEXAS, L.P.`). An unstripped comma does not
 * error — it splits the filter and silently widens the query — so the
 * characters are removed here rather than escaped.
 */
function nameTokens(raw: unknown): string[] {
  return String(raw ?? '')
    .replace(/[^A-Za-z0-9&\- ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5)
    .map((t) => encodeURIComponent(t.toUpperCase()));
}

/** AND the tokens within one column, so word order and adjacency do not matter. */
function columnMatch(column: string, tokens: string[]): string {
  const parts = tokens.map((t) => `${column}.ilike.*${t}*`);
  return parts.length === 1 ? parts[0] : `and(${parts.join(',')})`;
}

const CASE_COLUMNS =
  'case_number,court,case_status,case_status_code,filed_date,judgment_date,case_type,' +
  'style_plaintiff,style_defendant,plaintiff_name,defendant_name,' +
  'plaintiff_attorney,plaintiff_attorney_bar,defendant_attorney,defendant_attorney_bar,' +
  'defendant_city,defendant_state,source_file';

/**
 * Said on every response. The corpus cannot support "never been sued", and a
 * caller who assumes it can will report a clean absence as a clean bill of
 * health.
 */
const WINDOW_NOTE =
  'Harris County (TX) District Clerk official bulk files. The case index is a ROLLING ACTIVITY ' +
  'WINDOW, so this covers cases with activity in the periods ingested so far — an empty result ' +
  'means no matching case in that window, NOT that the party has never been sued in Harris County. ' +
  'Party rows come from the daily file and accumulate separately.';

function shapeCase(r: Record<string, unknown>) {
  return {
    case_number: r.case_number,
    court: r.court,
    case_type: r.case_type,
    // Decoded from the clerk's code via FIELD_CODES.xlsx; the raw code is kept
    // beside it because it is what the published file actually carries.
    status: r.case_status,
    status_code: r.case_status_code,
    filed_date: r.filed_date,
    judgment_date: r.judgment_date,
    style: `${r.style_plaintiff ?? ''} vs ${r.style_defendant ?? ''}`.trim(),
    plaintiff: r.plaintiff_name,
    defendant: r.defendant_name,
    plaintiff_attorney: r.plaintiff_attorney,
    plaintiff_attorney_bar: r.plaintiff_attorney_bar,
    defendant_attorney: r.defendant_attorney,
    defendant_attorney_bar: r.defendant_attorney_bar,
    defendant_location: [r.defendant_city, r.defendant_state].filter(Boolean).join(', '),
    source_file: r.source_file,
  };
}

const tools: ToolDef[] = [
  {
    name: 'harris_civil_search_party',
    description:
      'Find Harris County (Houston, TX) state civil court cases involving a named party — the "is this company being sued, and by whom" question that federal docket sources (court-listener, PACER) structurally cannot answer, because Texas state district court filings are not in them. Matches the party name as a substring against plaintiff, defendant and the clerk\'s case style, so "KROGER" finds "KROGER TEXAS L.P." and "THE KROGER CO". Optionally restrict to the side the party is on (role=defendant|plaintiff), case_type, or a filed-date range. Returns each case with cause number, court, case type, decoded status, filing and judgment dates, both parties and both attorneys with their Texas State Bar numbers. NOTE the corpus is a rolling activity window: an empty result means no matching case in the ingested window, not that the party has never been sued.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Party name to search for, e.g. "AMAZON LOGISTICS", "KROGER", "HALLIBURTON". Matched as a case-insensitive substring; multiple words are AND-ed so order does not matter.' },
        role: { type: 'string', description: 'Restrict to one side: "defendant" (being sued) or "plaintiff" (suing). Default searches both plus the case style.' },
        case_type: { type: 'string', description: 'Substring of the clerk\'s case type, e.g. "Motor Vehicle", "Debt", "Contract", "Injury".' },
        filed_after: { type: 'string', description: 'Only cases filed on or after this date (YYYY-MM-DD).' },
        filed_before: { type: 'string', description: 'Only cases filed on or before this date (YYYY-MM-DD).' },
        limit: { type: ['number', 'string'], description: 'Max cases (1-100, default 25).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'harris_civil_case',
    description:
      'Full detail for one Harris County (TX) civil case by its cause number (e.g. "202662585"): case type, status, filing and judgment dates, the style, both sides\' attorneys with State Bar numbers, and every party on the case — plaintiffs, defendants, intervenors, registered agents — which the case index alone does not carry. Party locations are city and state. Use after harris_civil_search_party returns a case_number.',
    inputSchema: {
      type: 'object',
      properties: {
        case_number: { type: 'string', description: 'The cause number as published by the District Clerk, e.g. "202662585". A few carry a trailing letter for severed matters.' },
      },
      required: ['case_number'],
    },
  },
  {
    name: 'harris_civil_recent_filings',
    description:
      'Recently filed Harris County (Houston, TX) civil cases, newest first — the "what is being filed in Houston right now" view. Optionally filter by case_type (e.g. "Motor Vehicle", "Debt", "Contract") or court number. Returns cause number, court, case type, decoded status, filing date, both parties and both attorneys.',
    inputSchema: {
      type: 'object',
      properties: {
        case_type: { type: 'string', description: 'Substring of the clerk\'s case type, e.g. "Motor Vehicle", "Debt".' },
        court: { type: 'string', description: 'District court number as published, e.g. "0055".' },
        filed_after: { type: 'string', description: 'Only cases filed on or after this date (YYYY-MM-DD).' },
        limit: { type: ['number', 'string'], description: 'Max cases (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'harris_civil_coverage',
    description:
      'What this Harris County docket corpus actually covers — case and party row counts, the filing-date range present, and the clerk files it was last built from. Call this before concluding anything from an empty search result: the corpus is a rolling activity window, and this tool is how you tell "no such case" from "not in the window covered".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

async function searchParty(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const tokens = nameTokens(args.name ?? args.party ?? args.query ?? args.q);
  if (tokens.length === 0) {
    return { error: 'Pass a party name of at least two characters, e.g. name: "KROGER".' };
  }

  const role = String(args.role ?? '').trim().toLowerCase();
  const columns =
    role.startsWith('def') ? ['defendant_name', 'style_defendant']
    : role.startsWith('pla') ? ['plaintiff_name', 'style_plaintiff']
    : ['defendant_name', 'plaintiff_name', 'style_defendant', 'style_plaintiff'];

  const parts = [`or=(${columns.map((c) => columnMatch(c, tokens)).join(',')})`];
  if (args.case_type) parts.push(`case_type=ilike.*${encodeURIComponent(String(args.case_type))}*`);
  if (args.filed_after) parts.push(`filed_date=gte.${encodeURIComponent(String(args.filed_after))}`);
  if (args.filed_before) parts.push(`filed_date=lte.${encodeURIComponent(String(args.filed_before))}`);

  const limit = clampInt(args.limit, 1, 100, 25);
  const query = parts.join('&');
  const rows = await pg<Array<Record<string, unknown>>>(
    cfg,
    'harris_civil_cases',
    `${query}&select=${CASE_COLUMNS}&order=filed_date.desc.nullslast&limit=${limit}`,
  );
  // Total behind the page, so a caller can tell 25-of-25 from 25-of-400.
  const total = await pgCount(cfg, 'harris_civil_cases', `${query}&select=case_number`);

  return {
    query: String(args.name ?? ''),
    role: role || 'any',
    count: rows.length,
    total_matching: total,
    ...(total === null
      ? {
          total_matching_unavailable:
            'The exact match count did not complete. null here means UNCOUNTED, not zero — the cases listed below are real.',
        }
      : {}),
    cases: rows.map(shapeCase),
    coverage_note: WINDOW_NOTE,
    source: 'Harris County District Clerk — official public bulk datasets',
  };
}

async function caseDetail(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const raw = String(args.case_number ?? args.cause_number ?? args.id ?? '').trim().toUpperCase();
  const caseNumber = raw.replace(/[^A-Z0-9]/g, '');
  if (!caseNumber) return { error: 'Pass a cause number, e.g. case_number: "202662585".' };

  const [cases, parties] = await Promise.all([
    pg<Array<Record<string, unknown>>>(
      cfg,
      'harris_civil_cases',
      `case_number=eq.${caseNumber}&select=*&limit=1`,
    ),
    pg<Array<Record<string, unknown>>>(
      cfg,
      'harris_civil_parties',
      // City and state only, to match what shapeCase() already returns for the
      // case leg. The street number, street, apartment and ZIP columns exist in
      // the mirror and are deliberately NOT selected here — see below.
      `case_number=eq.${caseNumber}&select=party_role,party_name,city,state,case_status,filed_date&order=party_role.asc&limit=200`,
    ),
  ]);

  if (cases.length === 0 && parties.length === 0) {
    return {
      case_number: caseNumber,
      found: false,
      // Not "no such case" — we cannot say that from a rolling window.
      note:
        `No case ${caseNumber} in the ingested windows. The case index is a rolling activity window, ` +
        'so this may be a real case with no activity in the periods held. Call harris_civil_coverage ' +
        'to see what is loaded.',
      coverage_note: WINDOW_NOTE,
    };
  }

  return {
    found: true,
    case: cases.length ? shapeCase(cases[0]) : null,
    ...(cases.length === 0
      ? {
          case_index_note:
            'This cause number appears in the daily party file but not in an ingested weekly case index, ' +
            'so party rows are available and the full case record is not.',
        }
      : {}),
    // `location`, not `address`: city and state, never the street.
    //
    // This leg used to join street_number + street + city + state + zip and
    // hand the result back as `address`. Measured live on 2026-09-02, case
    // 202581924B returned a named individual's full home address down to the
    // apartment number. The case leg above never did that — shapeCase() has
    // always returned city+state as `defendant_location` — so the two halves of
    // the same tool disagreed about what a party's location means, and only one
    // of them was reachable in the smoke test that closed the build.
    //
    // The street columns stay in the mirror (they are in the clerk's file and
    // dropping them is a separate, larger call about what the mirror holds —
    // filed for Bruce). They are simply not selected. Nothing this pack exists
    // to answer — "is Company X being sued in Harris County, and by whom" —
    // needs a private individual's doorstep.
    parties: parties.map((p) => ({
      role: p.party_role,
      name: p.party_name,
      location: [p.city, p.state].filter(Boolean).join(', ') || null,
    })),
    party_count: parties.length,
    coverage_note: WINDOW_NOTE,
    source: 'Harris County District Clerk — official public bulk datasets',
  };
}

async function recentFilings(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts: string[] = [];
  if (args.case_type) parts.push(`case_type=ilike.*${encodeURIComponent(String(args.case_type))}*`);
  if (args.court) parts.push(`court=eq.${encodeURIComponent(String(args.court))}`);
  if (args.filed_after) parts.push(`filed_date=gte.${encodeURIComponent(String(args.filed_after))}`);
  parts.push('filed_date=not.is.null');

  const limit = clampInt(args.limit, 1, 100, 25);
  const rows = await pg<Array<Record<string, unknown>>>(
    cfg,
    'harris_civil_cases',
    `${parts.join('&')}&select=${CASE_COLUMNS}&order=filed_date.desc&limit=${limit}`,
  );
  return {
    count: rows.length,
    cases: rows.map(shapeCase),
    coverage_note: WINDOW_NOTE,
    source: 'Harris County District Clerk — official public bulk datasets',
  };
}

async function coverage(cfg: SupabaseConfig) {
  const [cases, parties, oldest, newest, lastFile] = await Promise.all([
    pgCount(cfg, 'harris_civil_cases', 'select=case_number'),
    pgCount(cfg, 'harris_civil_parties', 'select=case_number'),
    pg<Array<Record<string, unknown>>>(cfg, 'harris_civil_cases', 'select=filed_date&filed_date=not.is.null&order=filed_date.asc&limit=1'),
    pg<Array<Record<string, unknown>>>(cfg, 'harris_civil_cases', 'select=filed_date&filed_date=not.is.null&order=filed_date.desc&limit=1'),
    pg<Array<Record<string, unknown>>>(cfg, 'harris_civil_cases', 'select=source_file,last_seen_at&order=last_seen_at.desc&limit=1'),
  ]);

  return {
    jurisdiction: 'Harris County, Texas (Houston) — District Clerk, civil district courts',
    cases: cases,
    party_rows: parties,
    ...(cases === null || parties === null
      ? {
          counts_unavailable:
            'A count did not complete. null means UNCOUNTED, not empty — search still works.',
        }
      : {}),
    filed_date_range: {
      earliest: oldest[0]?.filed_date ?? null,
      latest: newest[0]?.filed_date ?? null,
    },
    last_ingested_file: lastFile[0]?.source_file ?? null,
    last_ingested_at: lastFile[0]?.last_seen_at ?? null,
    coverage_note: WINDOW_NOTE,
    what_this_answers:
      'Whether a named company or person is a party to a Texas state civil suit in the largest ' +
      'county in Texas. Federal docket sources do not carry state district court filings.',
    source: 'Harris County District Clerk — official public bulk datasets',
  };
}

async function callTool(pwFetch: Fetcher, name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'harris-county is not configured on this deployment — an operator must set the ' +
        'pipeworx-dockets data credentials. This is a setup problem, not your arguments.',
    );
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey, fetch: pwFetch };

  switch (name) {
    case 'harris_civil_search_party':
      return searchParty(cfg, args);
    case 'harris_civil_case':
      return caseDetail(cfg, args);
    case 'harris_civil_recent_filings':
      return recentFilings(cfg, args);
    case 'harris_civil_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Build the pack around an injected bounded fetch.
 *
 * A factory rather than a plain default export because `fetchWithTimeout` can
 * only be resolved in index.ts — see the note at the top of this file. index.ts
 * applies `satisfies McpToolExport` to the result, so the real shared contract
 * is still checked, just one file further out.
 */
export function createPack(pwFetch: Fetcher) {
  return {
    tools,
    callTool: (name: string, args: Record<string, unknown>) => callTool(pwFetch, name, args),
    meter: { credits: 1 },
  };
}
