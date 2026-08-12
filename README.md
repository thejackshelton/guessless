# Guessless

Guess less about JavaScript and TypeScript structure. Guessless is a headless, deterministic structural-analysis engine that returns integrity-protected receipts instead of unqualified result lists — for tools and agents that need answers without silently treating uncertainty as fact.

## Honest by contract

Every query returns exactly one state:

- `complete` — the engine found no applicable unresolved site.
- `partial` — useful results, plus **every** unresolved site named with a closed, machine-readable reason (20 reasons; "other" is not one).
- `refused` — why the request cannot be answered safely.

Receipts bind the request, analyzer snapshot, results, semantic symbol anchors, unresolved sites, and canonical SHA-256 integrity. A bare result list is never a valid receipt. The analysis boundary is JavaScript, TypeScript, JSX, and TSX; anything else is refused, not guessed.

## Query surface

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

A reference is every site that names the symbol structurally, including the specifiers that carry it across module boundaries (`import { x }`, `import { x as y }`, `export { x } from '...'`); strings and comments are never evidence, and nothing hides behind `export *`. `writesOf` claims only proven assignments: a call like `records.push(...)` is named `method-call-mutation-uncertain`, an escape like `mutate(records)` is named `argument-escape-mutation-uncertain`, and `.map()` never appears as a mutation — `complete` means no assignment and no possible-mutation site went unnamed, never that the value was proven unmutated.

## Quick start

Requires Node.js 22+ and pnpm 10.33.2.

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` is the product gate and passes in any fresh checkout; sealed evidence-era suites are opt-in via `pnpm test:evidence` (rationale in `vite.config.ts`).

```sh
echo '{"inputs":[{"path":"src/api.ts","source":"export const answer = 42;"}],
      "request":{"kind":"exportedNames","file":"src/api.ts"}}' \
  | node packages/cli/dist/cli.js query -
```

`query` accepts a file path or `-` for stdin; `reproduce` re-verifies a saved receipt against the same ordered inputs. The MCP stdio server (`node packages/mcp/dist/server.js`), its snapshot/safe-change workflow, summary and paged views, and local benchmarks are documented in [`packages/mcp/README.md`](packages/mcp/README.md); the four-layer agent-harness integration (docs block, skill, stop-hook claim gate, CI reproduce check) is in [`INTEGRATION.md`](INTEGRATION.md).

## Architecture

```text
@guessless/engine  ->  @guessless/mcp  ->  guessless CLI
```

The engine owns parsing, linking, queries, anchors, receipt states, and integrity; it has no transport concerns. The MCP server is a thin adapter; the CLI lets a human check any answer an agent got.

## Evidence

The raw evidence bundles (receipts, scorers, sealed manifests) live in a local `docs/evidence` archive that is deliberately not published; the claims below are each backed by a named bundle in that archive.

- **Planted falsification**: the engine suite uses adversarial JS/TS/JSX/TSX fixtures with known ground truth, checking exact results, unresolved citations, integrity, and mutation guards. See [`packages/engine/test/`](packages/engine/test/).
- **Real repositories and scaling**: three pinned repos indexed without installed dependencies, an LSP comparison retained verbatim, and exact query timings from 10k to 1M lines (~1–2ms p50 at 10k; ~33–270ms at 1M). Sealed in the local evidence archive (`docs/evidence/oracle-part-2`, kept out of the published tree).
- **2026-08 defect campaign**: a ground-truthed trial against sibling-repo code (the `adoption-eval-fable-v1` trial) found four missed-and-unnamed defect classes; fixing them surfaced two more. All six are fixed fail-closed with class-level regression tests. The `adoption-eval-fable-v2` re-trial re-ran all 51 queries: **zero missed-and-unnamed, zero spurious** over 202 hand-audited sites. A falsifiable repo-scale demonstration (635 files / 161k lines, preregistered falsifiers — one genuinely fired and was fixed) then passed: zero decoy sites where grep's answer was 13.5% decoys, every unreturned site named by its route specifier, byte-identical receipts, 5.1s total.
- **Sealed history**: the earlier `oracle-part-3` bundles (including a v5 `DO_NOT_ADOPT` whose 68 tool calls were all cancelled client-side and so support no causal claim) remain immutable era records — archived in the same local evidence tree.

Not yet established, stated plainly: agent-in-the-loop benefit against the fixed engine (prior valid pairs showed no correctness lift and material overhead on small repos), MCP transport reliability under real agent clients, and `.tsrx` corpora (refused by design).

## Limitations

Guessless uses Yuku for JavaScript-family analysis and deliberately adds no fallback parser. Dynamic behavior, unresolved modules, opaque higher-order flow, and unsupported syntax remain named gaps. A `complete` receipt is scoped to the exact indexed snapshot and request; it is not a claim about runtime behavior.

## License

MIT
