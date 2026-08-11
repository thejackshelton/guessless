# Guessless

Guess less about JavaScript and TypeScript structure. Guessless is a headless, deterministic structural-analysis engine that returns integrity-protected receipts instead of unqualified result lists. It is designed for tools and agents that need useful answers without silently treating uncertainty as fact.

## Honest by contract

Every query returns exactly one state: `complete`, `partial`, or `refused`.

- `complete` means the engine found no applicable unresolved site.
- `partial` returns useful results and names every unresolved site with a closed, machine-readable reason.
- `refused` explains why the request cannot be answered safely.

Receipts bind the request, analyzer snapshot, results, semantic symbol anchors, unresolved sites, and canonical SHA-256 integrity. A bare result list is never a valid receipt. The analysis boundary is JavaScript, TypeScript, JSX, and TSX; unsupported languages are refused rather than guessed.

## Query surface

Guessless exposes nine structural queries:

| Query            | Answer                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `definitionOf`   | The definition of a symbol anchor.                                                                     |
| `referencesOf`   | All known references to a symbol, import and re-export specifiers included.                            |
| `readsOf`        | References that read a symbol.                                                                         |
| `writesOf`       | References that write the symbol itself; a call that may mutate it is named, never claimed as a write. |
| `exportedNames`  | The exported names of a module.                                                                        |
| `capturesOf`     | Values captured by a function or executable scope.                                                     |
| `resolveBinding` | A binding resolved by file, name, namespace, and optional scope.                                       |
| `reachableFrom`  | Named functions and values transitively reachable from a target.                                       |
| `reaches`        | Callers and values that can transitively reach a target.                                               |

**What a reference is.** Every site that names the symbol structurally: uses,
and the specifiers that carry it across a module boundary — `import { x }`,
`import { x as y }`, `export { x } from '...'`, and the local `export { x }`.
A name inside a string or a comment is not structural evidence and is never
reported. `export * from '...'` names no symbol, so it carries no specifier
site of its own; the specifiers that import a name through it are reported as
usual, so nothing hides behind the star.

**What `writesOf` claims.** A result means the symbol itself is assigned,
updated, or destructured into. It never means a call mutated the value: the
engine can prove the receiver of `records.push(...)` is the queried binding but
cannot see the callee's body, so such a call is reported as an unresolved
`method-call-mutation-uncertain` site rather than a write — `.map()` must never
appear as a mutation. A mutation reached through an alias is named
`property-alias-write-uncertain` on the same principle. So `complete` means no
assignment and no possible-mutation call site went unnamed; it never means the
value was proven unmutated. One limit is deliberately not claimed either way:
passing the binding to another function (`mutate(records)`) is not reported as
a possible mutation, because every argument of every call would qualify.

## Architecture

The packages follow one direction:

```text
@guessless/engine  ->  @guessless/mcp  ->  guessless CLI
```

- `@guessless/engine` owns parsing, linking, queries, semantic anchors, receipt states, and integrity verification. It has no transport concerns.
- `@guessless/mcp` is a thin stdio adapter. Each tool returns the engine receipt unchanged as structured content and JSON text.
- `guessless` is the human-facing CLI. It accepts one strict JSON document and can reproduce a prior receipt against the same ordered input set.

## Workspace usage

Requirements: Node.js 22 or newer and pnpm 10.33.2.

```sh
pnpm install
pnpm build
pnpm test
```

Create `query.json`:

```json
{
	"inputs": [
		{
			"path": "src/api.ts",
			"source": "export const answer = 42;"
		}
	],
	"request": {
		"kind": "exportedNames",
		"file": "src/api.ts"
	}
}
```

Run a query or reproduce a saved receipt:

```sh
node packages/cli/dist/cli.js query query.json
node packages/cli/dist/cli.js reproduce reproduction.json
```

Use `-` instead of a path to read the JSON document from stdin. Start the MCP stdio server with:

```sh
node packages/mcp/dist/server.js
```

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

## Evidence

### Oracle part 1: planted falsification

The engine test suite uses planted adversarial JavaScript, TypeScript, JSX, and TSX cases. It checks exact results and unresolved citations, receipt integrity and snapshot invalidation, binding and namespace behavior, reads and writes, captures, reachability, higher-order boundaries, and mutation guards that must fail red before byte-identical restoration. See [`packages/engine/test/receipt-oracle.test.ts`](packages/engine/test/receipt-oracle.test.ts) and the adjacent engine tests.

### Oracle part 2: real repositories, LSP comparison, and scaling

Three pinned licensed repositories were indexed from clean archives without installed dependencies. The evidence contains six partial and three complete receipts, plus three useful comparisons with `typescript-language-server`. The LSP results are retained as observations, not treated as ground truth. See the sealed [Oracle part 2 summary](docs/evidence/oracle-part-2/summary.md).

The exact recorded performance values are:

```text
10000 lines cold total (ns): 1068834, 404333, 356541.
10000 lines query p50/p95 (ns): definitionOf=1029958/1270208, referencesOf=2110292/2373250, readsOf=2108667/2368000, writesOf=2015750/2161333, exportedNames=2436458/2621041, capturesOf=1304459/1428417, resolveBinding=301167/397125, reachableFrom=1341167/1450458, reaches=1335375/1486417.
100000 lines cold total (ns): 3633750, 3164542, 3094417.
100000 lines query p50/p95 (ns): definitionOf=10407125/12406208, referencesOf=20296208/22684458, readsOf=18955625/22844166, writesOf=18963666/22050875, exportedNames=26045042/28682875, capturesOf=13616584/15241709, resolveBinding=2939042/3993584, reachableFrom=12893083/14801625, reaches=13364750/15097625.
1000000 lines cold total (ns): 33321792, 37175041, 32806833.
1000000 lines query p50/p95 (ns): definitionOf=100551250/109188167, referencesOf=203298584/213211375, readsOf=202324625/214440250, writesOf=202978125/212399250, exportedNames=269819458/278859667, capturesOf=134506625/141337583, resolveBinding=33323291/40602500, reachableFrom=134419917/142491292, reaches=134157209/143243958.
```

The synthetic workload is one TypeScript file with nine fixed code lines plus comment padding. It measures physical-line scaling, not real-project complexity.

### Oracle part 3: concluded, do not adopt in sibling projects now

The decision-grade `oracle-part-3-v5` benchmark completed all 36 preregistered cells and all 18 valid pairs. Its current, scoped recommendation is: **do not integrate Guessless into Markless, Frameless, Versionless, or comparable sibling repositories now**. This is not a universal or permanent claim about Guessless; it is the frozen decision for a reversible sibling-repository integration under this synthetic same-model protocol.

Control/Guessless correctness was 5/4 for rename, 0/0 for delete, and 4/6 for reach. Guessless therefore produced a real positive reach result, but it added false completeness, regressed rename correctness, and was slower with more tool calls across all seven both-correct pairs. Those results mechanically yield `DO_NOT_ADOPT` under the preregistered rule.

Read the [adoption decision](docs/evidence/oracle-part-3-adoption-decision.md) and sealed v5 [summary](docs/evidence/oracle-part-3-v5/summary.md), [decision](docs/evidence/oracle-part-3-v5/decision.json), [benchmarks](docs/evidence/oracle-part-3-v5/benchmarks.json), [replay](docs/evidence/oracle-part-3-v5/replay.json), and [manifest](docs/evidence/oracle-part-3-v5/manifest.json). The invalid immutable predecessors remain documented in the [v3 attempt report](docs/evidence/oracle-part-3-v3-attempt.md) and [v4 audit](docs/evidence/oracle-part-3-v4-audit.md); neither may be retried or rescored.

## Limitations

Guessless uses Yuku for JavaScript-family structural analysis and deliberately does not add a fallback parser. Dynamic behavior, unresolved modules, opaque higher-order flow, unsupported syntax, and other proof boundaries remain named gaps. A `complete` receipt is scoped to the exact indexed snapshot and request; it is not a claim about runtime behavior outside that boundary.

## License

MIT
