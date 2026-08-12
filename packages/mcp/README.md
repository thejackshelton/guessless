# @guessless/mcp

Thin stdio adapter over `@guessless/engine`. Each tool returns the engine receipt unchanged as structured content and JSON text. Start it with:

```sh
node packages/mcp/dist/server.js
```

## Workflow, views, and local benchmarks

The MCP workflow prepares an exact in-memory snapshot with
`guessless_prepare_snapshot`. It accepts either the existing non-empty `sources` batch or
a mutually exclusive canonical local `file:` `rootUri`. Root preparation is confined to
the server working root, never follows symlinks, applies a frozen bounded scan policy,
and reports exact coverage, excluded directories, outside-language files, indexed bytes,
and scan identity. It then passes the returned snapshot to
`guessless_safe_change_impact`. The impact call accepts one `rename`, `delete`, or
`entry-point` intent and either a semantic anchor or a strict binding selector such as
`{"file":"src/api.ts","name":"answer","space":"value"}`. It reports structural,
role-labelled sites and every unresolved boundary; it does not claim that a rename or
deletion is safe. A changed or mismatched snapshot refuses with `stale-snapshot` before
target resolution. Cold use is prepare plus impact (two calls), while an unchanged warm
snapshot needs one impact call.

The frozen local 24-file preparation benchmark measured:

| Workflow          | Calls | Request bytes | Response bytes | Combined bytes | Median elapsed |
| ----------------- | ----: | ------------: | -------------: | -------------: | -------------: |
| Explicit add/link |    25 |         2,588 |          5,848 |          8,436 |       0.915 ms |
| Batch sources     |     1 |         1,627 |          5,884 |          7,511 |       0.215 ms |
| Root reference    |     1 |           166 |          7,200 |          7,366 |       4.764 ms |

The unchanged batch request reduction remains 37.13%, a **MISS** against the
preregistered 80% request-byte target. Root-reference request bytes reduce 93.59%, a
**PASS** for that bounded reference path. Request bytes serialize exactly the
preregistered `{name, arguments}` payload. Complete-response bytes serialize the entire
returned `CallToolResult`, including MCP text fallback and `structuredContent`; combined
bytes add those compatible request and complete-response payload scopes over the same
calls. These payload counts omit JSON-RPC and transport envelopes and therefore are not
labelled wire bytes. Response and combined totals are disclosed separately and are not
substituted for the preregistered request-byte metric. These are local preparation
measurements, not end-to-end agent-efficiency evidence.

Safe-change impact also has an explicitly opt-in `view: "summary"`. The default with
`view` omitted remains the exact full receipt and JSON text fallback. Summary mode keeps
the complete request and requested/current snapshot binding, state, counts, full 64-hex
site identities with file and semantic labels, every ordered role and closed unresolved
reason, refused detail, proof handle, and its own integrity. It removes witnesses and
other full-proof detail from the initial response. Exact full receipts are retained per
server in a deterministic LRU bounded to eight entries and 256 KiB of serialized data.
`guessless_expand_safe_change_proof` returns the byte-exact retained proof; unknown,
evicted, and cross-instance handles refuse closed. A proof larger than the cache budget
is returned as the exact full result immediately, never as an unexpandable summary.

Large receipts can instead opt into `view: "paged"`. The bounded head commits the exact
request/snapshot/proof, canonical classified counts (including every closed unresolved
reason), ordered-fact root, exact `JSON.stringify` proof hash/bytes, page counts, and
content-bound first cursors. `guessless_safe_change_page` returns either ordered semantic
facts or base64 proof-byte chunks; semantic reads may declare exact file, role, and reason
filters, whose counts and digest cannot be confused with full coverage. Every complete
head/page `CallToolResult` is capped at 8,192 UTF-8 bytes. Cursors reject mutation,
cross-stream/filter replay, eviction, and cross-server reuse. Paged bundles use a separate
deterministic eight-handle LRU capped at 32 MiB compressed total and 64 MiB uncompressed
per proof; an unhonourable bound refuses instead of falling back inline. Omitted `view`
and `view: "summary"` retain their existing full-receipt and v1 behavior.

The frozen 24-file, 20-iteration all-intent benchmark measured complete `CallToolResult`
payloads (excluding JSON-RPC/transport envelopes):

| Workflow                | Calls | Request bytes | Response bytes | Combined bytes |    Median elapsed |
| ----------------------- | ----: | ------------: | -------------: | -------------: | ----------------: |
| Cold full               |     6 |         1,135 |         40,882 |         42,017 |         15.275 ms |
| Full warm               |     3 |           658 |         19,384 |         20,042 |          0.969 ms |
| Summary warm            |     3 |           709 |          8,547 |          9,256 |          0.979 ms |
| Optional expansion      |     3 |           420 |         19,384 |         19,804 | not latency-gated |
| Always expanded         |     6 |         1,129 |         27,931 |         29,060 | not latency-gated |
| Oversized full fallback |     3 |           709 |         19,384 |         20,093 | not latency-gated |

Summary response bytes were 55.91% lower than full warm, summary warm combined bytes
were 77.97% lower than cold, cold-to-summary median latency fell 93.59%, and summary was
1.09% slower than full warm in this final local run. The immediately preceding isolated
invocation also passed unchanged, with 93.54% cold-latency reduction and 2.02%
summary/full regression. The always-expanded and oversized rows
are disclosures, not savings claims; the oversized row uses the test-only one-byte cache
budget to exercise the production full-fallback behavior. No downstream agent-token or
natural-discovery improvement has been measured, so the separate 25% token gate remains
unproven.
