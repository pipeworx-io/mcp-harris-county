/**
 * Harris County (TX) District Clerk — civil docket bulk files.
 *
 * The clerk publishes the full civil docket as official bulk files at
 * /Common/e-services/PublicDatasets.aspx. That page is NOT disallowed by
 * robots.txt (which bars only /edocs/public/* and *.axd), and the files carry
 * strictly more than the disallowed case-detail pages, so nothing here goes
 * near a blocked path.
 *
 * WHY THIS LIVES IN workers/scraper AND NOT workers/data-pipeline:
 * data-pipeline expresses "fetch ONE url -> parse csv/tsv/jsonl/json -> upsert".
 * Neither half of that fits. The download is a two-request ASP.NET WebForms
 * postback (no static URL exists), and the weekly index is FIXED-WIDTH, which
 * the runner has no parser for. Same reasoning as the DD-15 dod_contracts
 * stage.
 *
 * THE TRAP, and it is the whole reason this module asserts on headers:
 * the download control names contain `$`, which must be percent-encoded as
 * %24 exactly the way a browser encodes a form. Get that wrong and the server
 * answers **HTTP 200 with the page re-rendered** — no error, no redirect, no
 * 4xx, just a 224 KB HTML document where the file should be. Three earlier
 * attempts read as clean successes. So every download here asserts on
 * `Content-Disposition: attachment`, NEVER on the status code
 * (docs/silent-zero-policy.md).
 *
 * URLSearchParams is the reason the encoding is right: its
 * application/x-www-form-urlencoded serializer escapes `$` as %24, whereas
 * `curl --data-urlencode` leaves it literal.
 */

export const HARRIS_DATASETS_URL =
  'https://www.hcdistrictclerk.com/Common/e-services/PublicDatasets.aspx';

// A plain browser UA. The site sits behind an F5 BIG-IP (it sets a
// BIGipServer* cookie), and a bot-signature UA is the documented way to get
// silently shaped by that class of appliance — same lesson as gov-auctions.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const DOWNLOAD_BUTTON =
  'ctl00$ctl00$ctl00$ContentPlaceHolder1$ContentPlaceHolder2$ContentPlaceHolder2$buttonDownload';

const FETCH_TIMEOUT_MS = 60_000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Every Set-Cookie on a response, folded into one Cookie request header. */
function collectCookies(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  let raw: string[] = [];
  if (typeof h.getSetCookie === 'function') raw = h.getSetCookie();
  if (raw.length === 0) {
    const single = res.headers.get('set-cookie');
    if (single) raw = [single];
  }
  const seen = new Map<string, string>();
  for (const line of raw) {
    // A folded multi-cookie header is comma-joined; each cookie's own
    // attributes are semicolon-joined, so split on ", " before a `name=`.
    for (const part of line.split(/,\s*(?=[^;=\s]+=)/)) {
      const pair = part.split(';', 1)[0].trim();
      const eq = pair.indexOf('=');
      if (eq > 0) seen.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ');
}

export interface HarrisForm {
  /** Every hidden input on the page, by name. Includes the ASP.NET __VIEWSTATE trio. */
  fields: Record<string, string>;
  cookie: string;
  html: string;
}

/** GET the datasets page and capture its form state + session cookies. */
export async function loadHarrisForm(): Promise<HarrisForm> {
  const res = await timedFetch(HARRIS_DATASETS_URL, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`datasets page HTTP ${res.status}`);
  const cookie = collectCookies(res);
  const html = await res.text();

  const fields: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/type\s*=\s*"hidden"/i.test(tag)) continue;
    const name = /name\s*=\s*"([^"]+)"/i.exec(tag);
    if (!name) continue;
    const value = /value\s*=\s*"([^"]*)"/i.exec(tag);
    fields[name[1]] = value ? decodeHtml(value[1]) : '';
  }
  if (!('__VIEWSTATE' in fields)) throw new Error('no __VIEWSTATE on datasets page');
  return { fields, cookie, html };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export interface HarrisDataset {
  /** The value to pass to downloadHarrisFile — e.g. `Civil\\2026-08-31 CivilHistoricalDaily.txt` */
  path: string;
  /** Bare filename, no folder. */
  filename: string;
  /** Leading folder — Civil, Criminal, … */
  folder: string;
}

/**
 * Every downloadable file the page advertises, read out of the
 * `DownloadDoc('Civil\\<name>')` onclick handlers.
 *
 * The page source carries a DOUBLED backslash because it is a JavaScript
 * string literal; the value the server wants is the SINGLE-backslash form.
 */
export function listHarrisDatasets(html: string): HarrisDataset[] {
  const out: HarrisDataset[] = [];
  const seen = new Set<string>();
  const re = /DownloadDoc\('([^']+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1].replace(/\\\\/g, '\\');
    if (seen.has(path)) continue;
    seen.add(path);
    const slash = path.lastIndexOf('\\');
    out.push({
      path,
      folder: slash >= 0 ? path.slice(0, slash) : '',
      filename: slash >= 0 ? path.slice(slash + 1) : path,
    });
  }
  return out;
}

export interface HarrisDownload {
  path: string;
  status: number;
  contentDisposition: string | null;
  contentType: string | null;
  bytes: number;
  text: string;
}

/**
 * POST the WebForms postback that serves one bulk file.
 *
 * Throws when the response is the re-rendered HTML page rather than a file —
 * which arrives as HTTP 200 and is indistinguishable from success by status
 * alone. `Content-Disposition: attachment` is the only honest signal.
 */
export async function downloadHarrisFile(path: string, form?: HarrisForm): Promise<HarrisDownload> {
  const f = form ?? (await loadHarrisForm());
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(f.fields)) body.set(k, v);
  body.set('hiddenDownloadFile', path);
  body.set(DOWNLOAD_BUTTON, '');

  const encoded = body.toString();
  // Guard the trap directly rather than trusting the serializer: if `$` ever
  // survives unencoded, the server answers 200-with-HTML and we would read it
  // as an empty file.
  if (!encoded.includes('%24')) throw new Error('form body did not percent-encode $ as %24');

  const res = await timedFetch(HARRIS_DATASETS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: HARRIS_DATASETS_URL,
      ...(f.cookie ? { Cookie: f.cookie } : {}),
    },
    body: encoded,
  });

  const contentDisposition = res.headers.get('content-disposition');
  const contentType = res.headers.get('content-type');
  const text = await res.text();
  const ok = (contentDisposition ?? '').toLowerCase().includes('attachment');
  if (!ok) {
    throw new Error(
      `no attachment header for ${path} — HTTP ${res.status}, content-type ${contentType ?? 'none'}, ` +
        `${text.length} bytes, starts ${JSON.stringify(text.slice(0, 120))}`,
    );
  }
  return {
    path,
    status: res.status,
    contentDisposition,
    contentType,
    bytes: text.length,
    text,
  };
}

/**
 * Reachability + download proof, run from the DEPLOYED worker.
 *
 * Exists because #627 and #807 both probed from a laptop, and #1056 measured a
 * case where laptop and Cloudflare egress gave different answers. Reads
 * nothing, writes nothing.
 */
export async function harrisProbe(opts: { daily?: string; weekly?: string } = {}): Promise<unknown> {
  const started = Date.now();
  const form = await loadHarrisForm();
  const datasets = listHarrisDatasets(form.html);

  const civil = datasets.filter((d) => d.folder === 'Civil');
  const dailyPath =
    opts.daily ??
    civil
      .filter((d) => /CivilHistoricalDaily\.txt$/i.test(d.filename))
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .pop()?.path;
  const weeklyPath =
    opts.weekly ??
    civil
      .filter((d) => /Civil Case Index JWEB \d{8}\.txt$/i.test(d.filename))
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .pop()?.path;

  const report: Record<string, unknown> = {
    page: {
      url: HARRIS_DATASETS_URL,
      html_bytes: form.html.length,
      cookies: form.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean),
      hidden_fields: Object.keys(form.fields).length,
      datasets_advertised: datasets.length,
      civil_datasets: civil.length,
    },
    egress: 'cloudflare-worker',
  };

  for (const [label, path] of [
    ['daily', dailyPath],
    ['weekly', weeklyPath],
  ] as const) {
    if (!path) {
      report[label] = { ok: false, error: 'no matching file advertised on the page' };
      continue;
    }
    try {
      const dl = await downloadHarrisFile(path, form);
      const lines = dl.text.split('\n');
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      report[label] = {
        ok: true,
        path,
        status: dl.status,
        content_disposition: dl.contentDisposition,
        content_type: dl.contentType,
        bytes: dl.bytes,
        lines: lines.length,
        line1: lines[0]?.slice(0, 260) ?? null,
        line2: lines[1]?.slice(0, 260) ?? null,
      };
    } catch (err) {
      report[label] = { ok: false, path, error: err instanceof Error ? err.message : String(err) };
    }
  }

  report.elapsed_ms = Date.now() - started;
  return report;
}
