# harris-county — Harris County (TX) District Clerk civil dockets

**Status: incubator. Not wired into `MCP_PACKS`, so nothing routes here.**
Fleet #1085. This pack holds the two halves that are *finished and measured*;
the tools are not written yet because they read a mirror table that does not
exist. See `../README.md` for the promotion checklist.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## What the corpus answers

"Is Company X being sued in Harris County state court, and by whom." That is
the question `court-listener` structurally cannot answer — it covers federal
dockets and appellate opinions, not Texas state civil filings. Harris County is
the largest single-county state civil corpus we have a sanctioned bulk path to.

Measured against the 20260829 weekly index: `AMAZON LOGISTICS INC` 12 cases,
`KROGER` 21, `WALMART INC` 15, `HALLIBURTON COMPANY` 3, `SYSCO HOUSTON INC` 3.

## What is here

| File | What it does |
|---|---|
| `src/bulk.ts` | Fetches the files. ASP.NET WebForms postback, two requests, no static URL. |
| `src/parse.ts` | Parses both files and decodes the coded fields. |
| `src/field-codes.json` | The clerk's own data dictionary, 14 sheets, ~5,000 codes. **Generated.** |
| `scripts/regen-field-codes.mjs` | Regenerates that JSON from the live `FIELD_CODES.xlsx`. No API key, no deps. |

## Verified, so nobody re-derives it

All of this was measured on 2026-09-02 against the real files, not inferred.

**Reachability from a deployed Cloudflare Worker — PASS.** `GET /admin/harris_probe`
on the deployed `registry-api` (not `wrangler dev`, not a laptop):

```
egress: cloudflare-worker, elapsed 2,244ms, 164 datasets advertised, 144 civil
daily   200  content-disposition: attachment;filename=2026-08-31 CivilHistoricalDaily.txt   207,352 B  1,385 lines
weekly  200  content-disposition: attachment;filename=Civil Case Index JWEB 20260829.txt  20,783,741 B  31,540 lines
```

**Weekly fixed-width layout — 42 fields, 0 misaligned rows out of 31,539.**
Offsets came from the header's label positions and are asserted on every parse
by `assertWeeklyHeader()`. 228 case numbers legitimately end in a letter
(severed/ancillary matters).

**Field decoding — 17 of 17 status codes present in the file are mapped**, none
unmapped: `A` ACTIVE 12,861 · `D` DISPOSED (FINAL) 12,454 · `E` READY DOCKET
3,342 · `H` HOLD FOR JUDGMENT 1,317 · `O` POST JUDGMENT 868 · `IP` INACTIVE
(PENDING) 63 · … Raw `D` is not a case status anyone can read; that is what
`FIELD_CODES.xlsx` is for.

## Three traps, all of which return HTTP 200

1. **The `$` in the postback control names must arrive as `%24`.** Get it wrong
   and the server answers **200 with the page re-rendered** — a 224 KB HTML
   document where the file should be. `curl --data-urlencode` leaves `$`
   literal; `URLSearchParams` encodes it. `downloadHarrisFile` asserts on
   `Content-Disposition: attachment`, never on the status code.
2. **A shifted column does not error.** Every field still slices, it just
   slices the wrong characters, and you ingest half a street name as a
   defendant. `assertWeeklyHeader()` is the only thing between that and the
   database — call `summarizeWeekly()` at ingest and require `misaligned === 0`.
3. **`*****   NO DEFENDANT RECORD found   *****` is a sentinel, not a name.**
   787 rows carry it. Ingested literally it becomes the third most-sued party in
   Harris County, ahead of the City of Houston. `parseWeeklyLine` blanks it.

## What is left

Everything except the load itself is now written and typechecked: the schema,
the ingest, its manual trigger, and the four tools. What remains needs database
credentials the machine that wrote it does not carry, so it stopped at the last
step that could be honestly verified from there rather than at a half-loaded
table.

**The operator runbook — the exact variable names, the load procedure and the
promotion checklist — is `docs/harris-county-handoff.md`.** It lives there and
not here because this README ships in the public standalone repo.

| Piece | Where |
|---|---|
| Schema, 2 tables + trigram indexes | `supabase/migrations/dockets_004_harris_civil.sql` |
| Ingest, batched upsert + dry-run mode | `workers/registry-api/src/harris_civil.ts` |
| Manual trigger, internal-secret gated | `POST /admin/harris_civil_sync` on registry-api |
| The four tools | `src/tools.ts` — exported as the pack default, still inert |

**Proven locally against the real files 2026-09-02** — the full path from
download through parse and decode to the exact row objects that would be
written, i.e. every step except the write itself:

```
daily  200  content-disposition: attachment;filename=2026-08-31 CivilHistoricalDaily.txt
            207,352 B   1,384 rows   0 columns holding the literal string "NULL"
weekly 200  content-disposition: attachment;filename=Civil Case Index JWEB 20260829.txt
            20,783,741 B   31,539 rows   header assertion PASS
            misaligned 0 · unmapped status codes none · 787 sentinel defendants blanked
            0 duplicate case numbers
decode      case_status_code "D" -> "DISPOSED (FINAL)" · filed_date 19981005 -> 1998-10-05
defendants  KROGER 21 · WALMART 15 · AMAZON LOGISTICS 6 · HALLIBURTON 3
```

That last line is the question this pack exists to answer, answered from the
parsed corpus. It is NOT a substitute for the live smoke test the promotion
checklist requires — that needs the table to exist.

## Notes for whoever loads it

- **The ingest refuses to write on a bad layout**, rather than writing rows that
  look fine. `misaligned` must be 0; a moved column still slices cleanly, so
  nothing else would catch it.
- **The weekly index is a rolling activity window**, so the case table
  accumulates across runs and absence never means "no such case". Every tool
  response carries that caveat — do not remove it to make the output tidier.
- **Both files self-collide.** The daily file can republish an amended party
  row, and a batch that conflicts with itself is rejected outright, so both
  loops dedupe on the table's own key before writing.
- **Memory:** the weekly download is a 20.8 MB string held for the whole run.
  Rows are flushed in batches of 500 rather than accumulated, which is what
  keeps a 128 MB Worker from also holding 31k 42-field objects.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "harris-county": {
      "url": "https://gateway.pipeworx.io/harris-county/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/harris-county/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/harris_civil_search_party \
  -H 'Content-Type: application/json' \
  -d '{"name":"KROGER","role":"defendant","limit":3}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/harris_civil_search_party`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "harris-county": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-harris-county"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-harris-county
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Harris County data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
