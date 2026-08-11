Fable-Opus-Unit: must-have-fixes-20260811/evaluation-ground-truth
Fable-Opus-Timeout-Minutes: 45

## Goal

Correct the evaluation harness's stale rename ground truth so the 6 failing tests in `packages/evaluation/test/evaluation.test.ts` go green again — by fixing the derivation, never by weakening what the tests assert.

Context: the engine's `referencesOf` now returns import specifiers and cross-module re-export specifiers as read-access results (semanticPath tails `site:import-specifier` / `site:reexport-specifier`), and `writesOf`-adjacent method calls can appear as unresolved sites with reason `method-call-mutation-uncertain` (see the merged reference-completeness work at HEAD and the README's updated query table). The harness predates this: `packages/evaluation/src/fixtures.ts:373` throws `rename reference is not a call` when a reference is not a call site — the exact blind spot the engine fix closed — and `proveReceiptGroundTruth` (~line 572) requires the freshly derived set to equal the packaged `ground-truth.json`. A rename genuinely must touch specifier sites, so the packaged ground truth is factually incomplete and the derivation's assumption is wrong.

Required work:
1. Update the derivation in `packages/evaluation/src/fixtures.ts` to accept and role-label specifier references as legitimate rename-affected sites (declaration/import-specifier/reexport-specifier/call/read/etc. per the shapes it already uses), keeping the derivation mechanical (derived from receipts, not hand-listed).
2. Regenerate the packaged v1–v5 fixture `ground-truth.json` files THROUGH the corrected derivation, so they now include the specifier sites. The regeneration must be reproducible (a derivation run, not hand edits).
3. All 6 failing tests green, with their assertion structure intact — equality against packaged ground truth stays an equality check; site-role proofs stay proofs.
4. If any of the 6 tests additionally verifies bytes of `docs/evidence/**` sealed bundles and now fails because the *sealed* answers differ from freshly derived truth, do NOT touch the sealed bundle and do NOT force equality: report blocked with the specific test and lines — that collision needs a PM ruling on recording era semantics.

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/evaluation/src/fixtures.ts`
- `packages/evaluation/test/evaluation.test.ts`
- `packages/evaluation/fixtures/**/ground-truth.json`

## Forbidden moves

- Do not touch `docs/evidence/**`, `packages/evaluation/fixtures/oracle-part-3-v6/**` or later (self-pinned seals), or any engine/mcp/cli source. Why: sealed evidence is immutable; the engine change is already merged.
- Do not delete or soften assertions to reach green; only the stale factual content (derivation assumption + regenerated ground truth) may change. Why: the tests are the harness's proof obligations.
- Do not edit `vite.config.ts` or move the suite to the evidence project. Why: PM ruled these tests are living harness correctness checks and stay in the default gate.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (including the sealed-bundle collision in step 4), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.