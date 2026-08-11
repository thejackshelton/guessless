Fable-Opus-Unit: must-have-fixes-20260811/evaluation-ground-truth-2
Fable-Opus-Timeout-Minutes: 45

## Goal

Complete the evaluation ground-truth correction started on branch `worktree-agent-af51395e5c7060e69` and take the default gate fully green. The PM has ruled on all four open questions from that attempt; this packet's contract reflects the rulings.

Start by merging the prior partial work into your own worktree branch: `git merge --no-edit worktree-agent-af51395e5c7060e69` (it contains only the corrected `renameRole()` derivation in `packages/evaluation/src/fixtures.ts`).

Then:
1. Regenerate the packaged ground truth THROUGH the corrected derivation for v1–v4: write the regenerated `ground-truth.json` files and update `groundTruthSha256` in `packages/evaluation/fixtures/oracle-part-3-v{1,2,3,4}/protocol.json` to the regenerated value (expected `a29b993ba82f72f658d6e37c981fbcc65e6da19b5260e085b1016bd160e8ce2d` under stableJson — trust your derivation output, not this constant, and state the value you produced).
2. RULING — v5 stays byte-identical. `packages/evaluation/fixtures/oracle-part-3-v5/**` must not change: its truth is hand-locked in `oracle-rationale.json` with `forbiddenAuthorities: GuesslessEngine, any parser` — the engine may never grade itself. The prior attempt verified all 6 tests go green with v5 untouched (its calibrate failure was inherited from v4).
3. Update `packages/evaluation/test/evaluation.test.ts:373` `sitesMissed` expectation 3 → 7 (factual count over the corrected planted-site set; assertion structure intact). Make any other factual-count updates the corrected truth requires, never structural ones — each with a one-line comment stating the count's derivation.
4. RULING — `docs/evidence/**` desync is accepted era semantics: sealed bundles remain byte-identical records of the pre-D2 contract. Do not touch them; do not add compatibility shims for them.

Acceptance: full default gate green (the 6 evaluation failures resolved, no new failures anywhere), plus typecheck and lint.

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/evaluation/src/fixtures.ts`
- `packages/evaluation/test/evaluation.test.ts`
- `packages/evaluation/fixtures/oracle-part-3-v1/**`
- `packages/evaluation/fixtures/oracle-part-3-v2/**`
- `packages/evaluation/fixtures/oracle-part-3-v3/**`
- `packages/evaluation/fixtures/oracle-part-3-v4/**`

## Forbidden moves

- Do not touch `packages/evaluation/fixtures/oracle-part-3-v5/**` or `-v6/**` and later, or `docs/evidence/**`. Why: v5 is independently hand-locked; v6+ are self-pinned seals; docs bundles are immutable era records.
- Do not hand-edit any regenerated ground-truth.json; only derivation output may land. Why: hand-listed truth is the failure mode this harness exists to prevent.
- Do not delete or soften assertions; factual count updates only, each with a derivation comment. Why: the tests are proof obligations.
- Do not touch engine/mcp/cli sources or `vite.config.ts`. Why: out of slice.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. green is not reachable with v5 untouched after all, contradicting the prior attempt's finding), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.