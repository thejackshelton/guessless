Fable-Opus-Unit: must-have-fixes-20260811/d5-argument-escape
Fable-Opus-Timeout-Minutes: 45
Fable-Opus-Effort: high
Effort-Justification: Final honesty-contract slice: must add argument-escape naming without over-claiming, AND narrow the existing method-call reason without losing true names — a two-sided precision/recall constraint the oracle scores mechanically.

## Goal

Close the residual honesty class from the v2 re-trial and correct the D3 over-naming, then flip the v2 oracle by delta re-measurement. Evidence: `docs/evidence/adoption-eval-fable-v2/report.md` (leading finding) and `raw-markless/q10-writes-records.receipt.json`.

**Part 1 — argument-position escape (the 7 residual sites).** In `writesOf`, when the queried binding appears in ARGUMENT position of a call (`encodeArrayBufferViewBuffer(value, path, seen, records, diagnostics)` — its reference escapes to a callee whose body is not analyzed for mutation), the site must be named as an unresolved site with an honest closed reason. Add `argument-escape-mutation-uncertain` to `UNRESOLVED_REASONS` (currently 18 members) unless you can justify folding into an existing reason without blurring its documented meaning — the doc comment must distinguish it from `method-call-mutation-uncertain` (receiver vs argument) and `higher-order-call-boundary`. The 7 markless sites are `value.ts` lines 223, 238, 261, 281, 288, 311, 331 in the serializer input set.

**Part 2 — receiver restriction (the 3 false alarms).** `method-call-mutation-uncertain` currently fires on `Object.values(X).includes(...)` (X is an argument of `Object.values`, and the receiver of `.includes` is a fresh array) and on `x = x.filter(...)` shapes. Restrict it to calls whose receiver IS the queried binding. The `Object.values(X)` case then falls under Part 1's argument-escape naming (X escapes into Object.values — honest, since Object.values alone can't mutate X but the general rule cannot know that without a builtin model; if you add a conservative builtin allowlist to suppress known-non-mutating callees like Object.values/Object.keys, document it in the same file and keep it tiny and provable). `x = x.filter(...)`: the assignment IS a write (already claimed as such); the `.filter` call with x as receiver stays method-call-mutation-uncertain only if x is the receiver — decide and document whether known-non-mutating array methods belong on the allowlist; when in doubt, name it.

**Part 3 — delta re-measure.** Re-run the affected v2 queries with `node packages/cli/dist/cli.js` REBUILT from your fix (in your worktree: install, build, then run) — all writesOf receipts (markless q04, q04b, q10, q13; versionless q15, q18) and any other receipt your change can affect (run the full v2 runner scripts if unsure: `raw-markless/run-markless-v2.mjs`, `raw-versionless/run-queries-v2.mjs`). Update the receipts in `docs/evidence/adoption-eval-fable-v2/`, re-run `score.mjs`, regenerate `scores.json`, and update `report.md`'s score table and oracle line. State `zero missed-and-unnamed: TRUE` only if the mechanical scorer reports zero across the entire bundle; if any residual remains, FALSE with the sites listed — honesty over green.

Engine regression tests (`packages/engine/test/`): the 7-escape fixture shape (arg-position naming); receiver-restriction negatives (`Object.values(x).includes`, method call on a different binding); allowlist behavior if you add one; existing 231-test gate stays green with pinned-hash updates only where receipt content legitimately changes.

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/engine/src/**`
- `packages/engine/test/**`
- `packages/*/dist/**`
- `docs/evidence/adoption-eval-fable-v2/**`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch `docs/evidence/adoption-eval-fable-v1/**` or any sealed bundle, or mcp/cli/oracle/evaluation sources. Why: eras are immutable; adapters inherit the engine.
- Do not claim `write` access for any call — escapes and method calls are named uncertain, never claimed. Why: false positives are the mirror dishonesty.
- Do not soften the scorer or ground truth to reach TRUE. Why: the oracle is the product.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
node -e 'const t=require("fs").readFileSync("docs/evidence/adoption-eval-fable-v2/report.md","utf8");const m=t.match(/zero missed-and-unnamed: (TRUE|FALSE)/);if(!m)throw new Error("missing oracle line");console.log("oracle:",m[1])'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.