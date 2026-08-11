Fable-Opus-Unit: must-have-fixes-20260811/d1-unlinked-inputs
Fable-Opus-Timeout-Minutes: 45
Fable-Opus-Effort: high
Effort-Justification: Engine linker semantics change touching the closed unresolved-reason contract, with adversarial regression tests; a wrong design here re-breaks the product's core honesty guarantee.

## Goal

Fix defect class D1 in the guessless engine, fail-closed: a supplied input file must never be silently invisible to a traversal query. Today, when a supplied input imports project files through specifiers that do not resolve within the supplied input set (e.g. webpack-style non-relative specifiers like `containers/App/actions`), that file never links into the module graph, so a `referencesOf` traversal neither returns its reference sites nor names it in `unresolved` — the receipt looks honestly `partial` (explained by other boundaries) while whole files are missing. Evidence: `docs/evidence/adoption-eval-fable-v1/raw-versionless/q23-references-reposLoaded.receipt.json` (alias imports verbatim — `containers/HomePage/saga.js` absent from results AND unresolved) vs `q25-references-reposLoaded-relativised.receipt.json` (only two import strings relativised — saga.js sites appear). The defect and suggested fix are summarized in `docs/evidence/adoption-eval-fable-v1/verdict.md`.

Required behavior (the class, not the fixture): for every traversal-based query (`referencesOf`, `readsOf`, `writesOf`, `reachableFrom`, `reaches`, and `definitionOf`/`capturesOf` where traversal applies), any supplied input file that could not be established as linked into the traversed graph — because one or more of its import/re-export specifiers failed to resolve to a supplied input or a recognized external/builtin — must appear as a named unresolved site in the receipt, anchored to the file and offending specifier(s), with a closed machine-readable reason. Add a new named reason to `UNRESOLVED_REASONS` in `packages/engine/src/contracts.ts` (e.g. `unlinked-input`) if none of the existing 16 reasons is honest for this case; never widen an existing reason's meaning silently. Consequence: a receipt that today says `complete` over a graph containing unlinked inputs must become `partial`. A fully-linked input set must produce receipts identical in results to today (no noise for unrelated files).

Constraints:
- The engine is `yuku-analyzer` 0.8.4 (`Analyzer`, `link()`); do not add a second parser or change the JS/TS/JSX/TSX boundary.
- Preserve receipt schema compatibility: `verifyReceipt`, canonicalization, and integrity hashing must continue to work; existing tests that pin integrity/snapshot hashes may be updated in-contract when the receipt content legitimately changes.
- Fail closed: when in doubt whether a file linked, name it, don't guess.

Regression tests (in `packages/engine/test/`), covering the class:
1. The q23/q25 reproduction: three-plus-file fixture where a file references the target but imports it via a non-relative alias specifier — assert the file's absence from results is accompanied by a named unresolved entry citing that file and specifier; assert the relativised twin returns the sites and drops that entry.
2. Chained alias: an unlinked file that is itself reached only through another alias specifier.
3. Alias re-export: `export { x } from 'app/thing'` style specifier that fails to resolve.
4. Negative control: a fully-linked input set yields receipts with no new unresolved entries and unchanged results.

Then run the full verification below and make it green — the existing 258 tests must pass (updating pinned hashes only where the receipt content change is the intended one, with the intent stated in the test).

You are in a fresh git worktree without node_modules. Your FIRST command must be `pnpm install --frozen-lockfile --prefer-offline`. If installation cannot complete offline-ish, return blocked rather than fighting the network.

## File contract

- `packages/engine/src/**`
- `packages/engine/test/**`
- `packages/*/dist/**`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch `packages/mcp`, `packages/cli`, `packages/oracle`, `packages/evaluation` sources. Why: this slice is the engine defect; adapters pick it up through the rebuilt engine.
- Do not modify anything under `docs/`. Why: sealed evidence and the goal board are immutable to this slice.
- Do not delete or weaken any existing test to make verification pass; hash-pin updates must keep the test's original assertion intent. Why: the suite is the honesty corpus.
- Do not remove or rename any existing `UNRESOLVED_REASONS` member. Why: closed enumeration, extended by ruling only.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. the linker cannot distinguish unlinked inputs without adapter changes), dependencies cannot install in the worktree, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.