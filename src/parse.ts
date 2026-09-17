/**
 * Harris County (TX) District Clerk — parsers for the two civil bulk files,
 * plus the field-code decoding the raw files do NOT do for you.
 *
 * Both layouts were derived from, and verified against, the real files served
 * by the clerk on 2026-09-02 (fleet #1085):
 *
 *   daily   `Civil\<YYYY-MM-DD> CivilHistoricalDaily.txt`
 *           tab-delimited, header row, 1,385 rows on 2026-08-31.
 *           One row per PARTY, so a case appears once per party.
 *   weekly  `Civil\Civil Case Index JWEB <YYYYMMDD>.txt`
 *           FIXED-WIDTH, 20.8 MB, 31,539 data rows on 20260829.
 *           One row per CASE, carrying plaintiff, defendant and both
 *           attorneys with their State Bar numbers.
 *
 * WHY THE WEEKLY OFFSETS ARE HARD-CODED RATHER THAN SNIFFED. The file is
 * fixed-width with the trailing blanks stripped, so line LENGTH varies
 * (measured: 806 on 10,265 rows, 623 on 11,491, and 90-odd other widths) and
 * carries no column information. The offsets below come from the header row's
 * label positions; `WEEKLY_HEADER_LABELS` records what that header said so a
 * future layout change is detectable instead of silently shifting every field
 * by a few characters — which would not error, it would just return the wrong
 * person's name. Call `assertWeeklyHeader()` on every ingest.
 *
 * VERIFIED: all 31,539 rows of the 20260829 file parse with zero misalignment
 * (case number, court, status, filed date and judgment date each match their
 * expected shape on every row). 228 case numbers legitimately carry a trailing
 * letter — severed/ancillary matters — so the case-number pattern allows it.
 */

import FIELD_CODES from './field-codes.json';

// ---------------------------------------------------------------------------
// Field codes
// ---------------------------------------------------------------------------

type CodeSheet = Record<string, string>;
const SHEETS = FIELD_CODES as unknown as Record<string, CodeSheet | string | Record<string, number>>;

/**
 * Decode one coded value using a named sheet of `FIELD_CODES.xlsx`.
 *
 * Returns the raw value UNCHANGED when the sheet has no entry for it, because
 * an unmapped code is still real data — dropping it would turn a coverage gap
 * into a silent hole. Callers that care can compare against the input.
 */
export function decodeCode(sheet: string, code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const key = String(code).trim();
  if (!key) return null;
  const table = SHEETS[sheet];
  if (!table || typeof table !== 'object') return key;
  const hit = (table as CodeSheet)[key];
  return typeof hit === 'string' && hit ? hit : key;
}

/** `A` -> `ACTIVE`, `D` -> `DISPOSED (FINAL)`, `IP` -> `INACTIVE (PENDING)`. */
export const decodeCaseStatus = (code: string | null | undefined) => decodeCode('cst', code);
/** Party/counsel role codes, e.g. `3PD` -> `THIRD PARTY DEFENDANT`. */
export const decodeConnectionCode = (code: string | null | undefined) => decodeCode('coc', code);
/** Docket codes, e.g. `DKAC` -> `Ancillary Docket`. */
export const decodeDocketCode = (code: string | null | undefined) => decodeCode('dkt', code);
/** Judgment codes, e.g. `10A` -> `JUDGMENT FOR PLAINTIFF BY DIRECTED VERDICT/N.O.V.`. */
export const decodeJudgment = (code: string | null | undefined) => decodeCode('judgment', code);
/** Activity codes from the ActivityMods files, e.g. `1` -> `REMOVED TO FEDERAL COURT`. */
export const decodeActivity = (code: string | null | undefined) => decodeCode('act', code);

// ---------------------------------------------------------------------------
// Daily file — tab-delimited, one row per party
// ---------------------------------------------------------------------------

export interface HarrisDailyRow {
  case_number: string;
  cdi: string;
  court: string;
  filed_date: string | null;
  case_type: string | null;
  case_status: string | null;
  party_role: string | null;
  party_name: string;
  // street_number/street deliberately absent — see the note on WEEKLY_FIELDS.
  city: string | null;
  state: string | null;
  zip: string | null;
}

const DAILY_HEADER = [
  'CaseNbr', 'CDI', 'CourtID', 'FileDt', 'CaseType', 'CaseStatus', 'PartyRole',
  'PartyName', 'StreetNum', 'Street', 'City', 'State', 'Zip',
];

/**
 * The daily file writes the four-character string `NULL` for a missing value
 * rather than leaving the field empty, so a naive parse yields addresses in
 * the town of NULL.
 */
function dailyValue(s: string | undefined): string | null {
  const v = (s ?? '').trim();
  return !v || v === 'NULL' ? null : v;
}

/**
 * Parse `<date> CivilHistoricalDaily.txt`.
 *
 * Throws on a header that is not the expected 13 columns — the clerk serves
 * the re-rendered HTML page with HTTP 200 when a download goes wrong, and that
 * page would otherwise parse to zero rows and read as a quiet day in court.
 */
export function parseHarrisDaily(text: string): HarrisDailyRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('daily file is empty');
  const header = lines[0].split('\t').map((h) => h.trim());
  if (header.length !== DAILY_HEADER.length || header[0] !== DAILY_HEADER[0]) {
    throw new Error(
      `daily header is not the expected ${DAILY_HEADER.length} columns — got ${header.length}: ` +
        JSON.stringify(lines[0].slice(0, 200)),
    );
  }
  const out: HarrisDailyRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const caseNumber = (c[0] ?? '').trim();
    if (!caseNumber) continue;
    out.push({
      case_number: caseNumber,
      cdi: (c[1] ?? '').trim(),
      court: (c[2] ?? '').trim(),
      // `2026-08-31 00:00:00` — the time component is always midnight.
      filed_date: dailyValue(c[3])?.slice(0, 10) ?? null,
      case_type: dailyValue(c[4]),
      // Already spelled out in this file ("Active  - Civil"), but the doubled
      // internal space is the clerk's, not ours.
      case_status: dailyValue(c[5])?.replace(/\s{2,}/g, ' ') ?? null,
      party_role: dailyValue(c[6])?.replace(/\s{2,}/g, ' ') ?? null,
      party_name: (c[7] ?? '').trim(),
      // c[8]/c[9] are street_number/street in the daily file and are skipped:
      // same decision as the weekly index (fleet #1150). c[10]+ still read by
      // absolute position, so this changes nothing else.
      city: dailyValue(c[10]),
      state: dailyValue(c[11]),
      zip: dailyValue(c[12]),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weekly file — fixed-width, one row per case
// ---------------------------------------------------------------------------

/** `[column, startOffset, endOffset]`, half-open, from the header label positions. */
export const WEEKLY_FIELDS: ReadonlyArray<readonly [string, number, number]> = [
  ['case_number', 0, 13],
  ['court', 13, 17],
  ['case_status_code', 17, 21],
  ['filed_date', 21, 30],
  ['judgment_date', 30, 39],
  ['case_type', 39, 70],
  ['style_plaintiff', 70, 111],
  ['style_defendant', 111, 152],
  ['plaintiff_name', 152, 203],
  // ADDRESS AND PHONE ARE DELIBERATELY NOT PARSED (fleet #1150, Bruce 2026-09-02:
  // "let's hide address and phone / keep city state and zip").
  //
  // The clerk's file still carries street_number/street/apt/phone for both
  // parties and both attorneys at the offsets that used to be listed here. They
  // are not sliced, so the values never enter this process at all — which is a
  // stronger guarantee than dropping the column, because nothing downstream can
  // reintroduce them by accident. city/state/zip ARE kept: they answer "where
  // was this filed and who is local" without giving a doorstep.
  //
  // If you are here because you found those offsets in the clerk's layout doc
  // and wondered why they were missing: this is why. Do not add them back
  // without a decision that says so.

  ['plaintiff_city', 251, 287],
  ['plaintiff_state', 287, 290],
  ['plaintiff_zip', 290, 300],
  ['plaintiff_attorney', 311, 362],
  ['plaintiff_attorney_bar', 362, 371],
  ['plaintiff_attorney_city', 419, 455],
  ['plaintiff_attorney_state', 455, 458],
  ['plaintiff_attorney_zip', 458, 468],
  ['defendant_name', 479, 530],
  ['defendant_city', 578, 614],
  ['defendant_state', 614, 617],
  ['defendant_zip', 617, 627],
  ['defendant_attorney', 638, 689],
  ['defendant_attorney_bar', 689, 698],
  ['defendant_attorney_city', 746, 782],
  ['defendant_attorney_state', 782, 785],
  ['defendant_attorney_zip', 785, 795],
] as const;

/**
 * The header labels, at the offsets they occupied on 20260829. Two labels each
 * cover two adjacent fields (`CRT CS`, `STR-NM STR-NAM`, `ST ZIP`), which is
 * why the offset table above is authoritative and this is only a tripwire.
 */
const WEEKLY_HEADER_LABELS: ReadonlyArray<readonly [number, string]> = [
  [0, 'CAS-NUM'], [13, 'CRT CS'], [21, 'FIL-DT'], [30, 'JUD-DT'], [39, 'CASE TYPE'],
  [70, 'STYLE PLAINTIFF'], [111, 'STYLE DEFENDANT'], [152, 'PLAINTIFF NAME'],
  [311, 'ATY NAME'], [362, 'ATY BAR'], [479, 'DEFENDANT NAME'], [638, 'ATY NAME'],
  [689, 'ATY BAR'],
];

/**
 * Fail loudly if the clerk moves a column.
 *
 * A shifted layout does not error on its own: every field still slices, it
 * just slices the wrong characters, so you would ingest half a street name as
 * a defendant. This is the only thing standing between that and the database.
 */
export function assertWeeklyHeader(headerLine: string): void {
  for (const [offset, label] of WEEKLY_HEADER_LABELS) {
    const got = headerLine.slice(offset, offset + label.length);
    if (got !== label) {
      throw new Error(
        `weekly header moved: expected ${JSON.stringify(label)} at offset ${offset}, ` +
          `got ${JSON.stringify(got)} — the fixed-width offsets in WEEKLY_FIELDS are stale`,
      );
    }
  }
}

/**
 * The clerk writes a SENTINEL, not a blank, when a case has no defendant on
 * file: `*****   NO DEFENDANT RECORD found   *****`, on 787 of the 31,539 rows
 * in the 20260829 index. Ingested literally it becomes the third most-sued
 * "party" in Harris County — a fabricated entity with more cases than the City
 * of Houston. Blanked here, at the parse boundary, so nothing downstream has
 * to know about it.
 */
const NO_RECORD_SENTINEL = /^\*+\s*NO [A-Z ]+ RECORD found\s*\*+$/i;

export type HarrisWeeklyRaw = Record<string, string>;

export interface HarrisWeeklyRow extends HarrisWeeklyRaw {
  /** Decoded from `case_status_code` via the `cst` sheet of FIELD_CODES.xlsx. */
  case_status: string;
}

/** `19981005` -> `1998-10-05`; anything else -> `''`. */
function isoDate(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : '';
}

/**
 * Parse one data line of the weekly index. Lines are right-trimmed by the
 * clerk, so `slice` past the end yields `''` — which is the correct answer for
 * a field the row does not carry.
 */
export function parseWeeklyLine(line: string): HarrisWeeklyRow {
  const row: HarrisWeeklyRaw = {};
  for (const [name, start, end] of WEEKLY_FIELDS) {
    const v = line.slice(start, end).trim();
    row[name] = NO_RECORD_SENTINEL.test(v) ? '' : v;
  }
  row.filed_date = isoDate(row.filed_date);
  row.judgment_date = isoDate(row.judgment_date);
  return { ...row, case_status: decodeCaseStatus(row.case_status_code) ?? '' };
}

/**
 * Parse `Civil Case Index JWEB <YYYYMMDD>.txt` in full.
 *
 * Checks the header before touching a single row — see `assertWeeklyHeader`.
 */
export function parseHarrisWeekly(text: string): HarrisWeeklyRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('weekly file is empty');
  assertWeeklyHeader(lines[0]);
  const out: HarrisWeeklyRow[] = [];
  for (const line of lines.slice(1)) {
    const row = parseWeeklyLine(line);
    if (row.case_number) out.push(row);
  }
  return out;
}

/**
 * The shape every parsed row is expected to hold. Used by
 * `scripts/verify-parse.mjs` to prove the offsets still line up against a
 * freshly downloaded file, rather than against a fixture that can rot.
 */
export const WEEKLY_ROW_SHAPE: ReadonlyArray<readonly [string, RegExp]> = [
  // 228 of 31,539 rows on 20260829 carried a trailing letter — severed matters.
  ['case_number', /^\d{8,12}[A-Z]?$/],
  ['court', /^\d{0,4}$/],
  ['case_status_code', /^[A-Z]{0,2}$/],
  ['filed_date', /^(\d{4}-\d{2}-\d{2})?$/],
  ['judgment_date', /^(\d{4}-\d{2}-\d{2})?$/],
];

export interface WeeklySummary {
  rows: number;
  /** Rows where a field did not match `WEEKLY_ROW_SHAPE` — must be 0. */
  misaligned: number;
  /** First few offending rows, for the error message. */
  misaligned_examples: string[];
  /** Case numbers carrying a trailing letter (severed/ancillary matters). */
  case_number_with_letter_suffix: number;
  /** `{ code: count }` over `case_status_code`. */
  status_histogram: Record<string, number>;
  /** Status codes present in the file that FIELD_CODES.xlsx does not define. */
  unmapped_status_codes: string[];
  /** Rows whose defendant was the `NO DEFENDANT RECORD found` sentinel. */
  no_defendant_record: number;
}

/**
 * Parse the weekly file and measure whether it still lines up.
 *
 * Run this at ingest, not just in a test: a fixture cannot catch the clerk
 * changing the layout next month, and the symptom of that change is not an
 * error — it is 31,000 rows of plausible-looking wrong names. `misaligned`
 * must be 0; anything else means the offsets are stale.
 *
 * Baseline, `Civil Case Index JWEB 20260829.txt` (measured 2026-09-02):
 * rows 31,539 · misaligned 0 · letter-suffixed case numbers 228 ·
 * 17 distinct status codes, all mapped (A 12,861 · D 12,454 · E 3,342 · … ) ·
 * 787 rows with no defendant on file.
 */
export function summarizeWeekly(text: string): { rows: HarrisWeeklyRow[]; summary: WeeklySummary } {
  const rows = parseHarrisWeekly(text);
  const summary: WeeklySummary = {
    rows: rows.length,
    misaligned: 0,
    misaligned_examples: [],
    case_number_with_letter_suffix: 0,
    status_histogram: {},
    unmapped_status_codes: [],
    no_defendant_record: 0,
  };
  const unmapped = new Set<string>();
  for (const row of rows) {
    for (const [field, shape] of WEEKLY_ROW_SHAPE) {
      if (shape.test(row[field] ?? '')) continue;
      summary.misaligned++;
      if (summary.misaligned_examples.length < 5)
        summary.misaligned_examples.push(`${field}=${JSON.stringify(row[field])}`);
      break;
    }
    if (/[A-Z]$/.test(row.case_number)) summary.case_number_with_letter_suffix++;
    if (!row.defendant_name) summary.no_defendant_record++;
    const code = row.case_status_code;
    if (code) {
      summary.status_histogram[code] = (summary.status_histogram[code] ?? 0) + 1;
      // decodeCode returns the input unchanged when the sheet has no entry.
      if (row.case_status === code) unmapped.add(code);
    }
  }
  summary.unmapped_status_codes = [...unmapped].sort();
  return { rows, summary };
}
