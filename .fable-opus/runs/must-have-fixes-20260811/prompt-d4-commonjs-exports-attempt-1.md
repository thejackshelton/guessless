Fable-Opus-Unit: must-have-fixes-20260811/d4-commonjs-exports
Fable-Opus-Timeout-Minutes: 45

## Goal

Fix defect class D4 in the guessless engine, fail-closed: export forms the engine cannot classify — CommonJS `module.exports = {...}`, `module.exports.x = ...`, `exports.x = ...`, and any other unrecognized export construct — must be named as unresolved sites in `exportedNames` receipts instead of being silently absent. Evidence: `docs/evidence/adoption-eval-fable-v1/raw-versionless/q11-exportednames-i18n-cjs.receipt.json` — a CommonJS module with 4 real exports returns `partial` with 0 results, where the 5 unresolved entries only name require-boundaries, never the export assignments themselves; a consumer cannot distinguish "this module exports nothing" from "this module's exports are invisible to me".

Required behavior (the class, not the fixture): `exportedNames` on a module containing export-like constructs outside the ES module system names each such construct as an unresolved site (anchored to the assignment/expression) with a closed machine-readable reason — add one new named member to `UNRESOLVED_REASONS` in `packages/engine/src/contracts.ts` if none of the existing 18 fits honestly (e.g. `unrecognized-export-form`; the enum currently ends `...'unlinked-input', 'method-call-mutation-uncertain'`). Do NOT implement CommonJS export *analysis* — no results are claimed, only the sites named; guessless stays an ES-analysis engine that refuses to guess. ES modules must produce byte-identical receipts to today.

Regression tests in `packages/engine/test/`:
1. The q11 shape: CJS module with `module.exports = { a, b }` and `exports.c = ...` — `exportedNames` returns `partial`, 0 results, with each export construct named unresolved under the new reason.
2. Mixed file: ES exports plus a stray `module.exports.legacy = ...` — ES exports returned as results, the CJS assignment named unresolved.
3. Adversarial variant: aliased/indirect forms (`const m = module; m.exports.x = ...` or computed `exports[key] = ...`) — must be named (reason may be the new one or an honest existing one like `computed-property-key` for the computed case), never silent.
4. Negative control: a pure ES module produces receipts byte-identical to the current engine (pin an integrity hash from HEAD before your change and assert it after).

Existing suite must stay green: current default gate at HEAD is 224 passed / 8 skipped / 0 failed. Update pinned hashes only where receipt content legitimately changes, stating intent.

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/engine/src/**`
- `packages/engine/test/**`
- `packages/*/dist/**`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch `packages/mcp`, `packages/cli`, `packages/oracle`, `packages/evaluation` sources or tests, or anything under `docs/`. Why: adapters inherit the engine; evidence and board are immutable to this slice.
- Do not delete or weaken existing tests. Why: the suite is the honesty corpus.
- Do not remove or rename any existing `UNRESOLVED_REASONS` member. Why: closed enumeration, extended by ruling only.
- Do not add CommonJS semantic analysis (claiming export names as results). Why: out of scope and off-thesis — naming the boundary is the product.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. yuku does not expose the CJS assignment nodes needed for anchoring), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.