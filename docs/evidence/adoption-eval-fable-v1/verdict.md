# Guessless adoption verdict — fable-opus cockpit run `adoption-eval-20260811`

Date: 2026-08-11. Director: Claude (Fable 5) via the fable-opus cockpit; four Opus worker units, all completed, verify commands green, 43 minutes wall clock. Evidence: `markless-report.md`, `versionless-report.md`, `ab/`, `raw-markless/`, `raw-versionless/` in this directory. Worker claims below were spot-verified by the director against raw receipts and source before acceptance.

## Verdict

**Do not wire guessless into markless/versionless agent workflows yet — but the reason is four specific, fixable engine defects, not the product thesis.** Every prior sealed DO_NOT/NO_GO verdict was either causally void or a harness artifact (see "Prior evidence decomposed"). This run produced the first defect list that is actionable: fix the four classes below and the honesty contract genuinely holds on real family-repo code; the engine's precision is already excellent (0 spurious sites across 46 scored queries, 100% use-site recall, correct refusal/boundary behavior, useful answers on unbuildable legacy code where no LSP can run).

Agent-facing *value* remains unproven and currently negative-to-neutral on small/medium repos: in our A/B (n=1/arm, directional) both arms answered fully correctly, and the guessless arm paid 1.8× wall time, 1.65× tokens, +11 tool calls, and had to override the tool twice. This matches the only valid prior causal pair (fast-value-validation pair one). The value case that survives is: repos too large to sweep exhaustively, unbuildable/mid-migration corpora (versionless), reachability/behaviour queries, and mechanical receipt-verification in CI — none of which the trials to date have measured.

## The four defect classes (all missed-and-unnamed relative to the contract)

| # | Defect | Evidence | Severity |
|---|--------|----------|----------|
| D1 | Files imported via non-relative/webpack-alias specifiers are silently dropped from `referencesOf` traversal — absent from `results` **and** `unresolved` | `raw-versionless/q23` vs `q25`: relativizing two import strings alone surfaces `saga.js` and 2 real sites | Critical — guts the contract on exactly the versionless legacy corpus |
| D2 | `referencesOf` omits import and cross-module re-export specifiers under `complete` (local export specifiers ARE returned) | markless: 7 sites across 3 symbols; versionless: all 16 ground-truth import specifiers | Critical for the flagship rename use case |
| D3 | `writesOf` is assignment-only; returns `complete` with zero results on a binding mutated by ten `.push()` calls, while README promises "write **or may mutate**" | `raw-markless/q10` vs `packages/serializer/src/value.ts` (10 push sites); replicated in versionless `q15/q16` | Critical — wrong-if-trusted answer to "is it safe to change this" |
| D4 | CommonJS `module.exports` invisible to `exportedNames` (0 results); receipt is honestly `partial` with require-boundaries named, but the missed exports are not named | `raw-versionless/q11` | Moderate — expressiveness gap, not a bare false complete |

Suggested fail-closed fixes (no new analysis power needed): D1 — at link time, name every supplied input whose specifiers failed to join the graph as an unresolved site (the data exists); D2 — emit specifier sites (the engine already anchors them for local exports); D3 — treat any member-call on a tracked binding as a named unresolved "possible mutation" site, or implement may-mutate classification; D4 — name unrecognized export-assignment forms as unresolved sites.

## Per-repo adoption answer

- **markless**: not now. Beyond the defects, guessless refuses `.tsrx` (6,022 files) by design — coverage there is limited to the `.ts` toolchain code. Boundary behavior is honest (clean `unsupported-language` refusal; omitted `.tsrx` yields `partial` naming the specifier).
- **versionless**: the strongest future fit — guessless answered usefully on the react-boilerplate fixture with no node_modules, no tsconfig, JSX-in-.js, where an LSP needs a full 2019-era install. But D1 lives on exactly this corpus's import style; fix D1 first.
- **frameless / family CI**: the receipt + `reproduce` machinery could mechanically back citation checks (the check-citations use case) once D1–D3 are fixed. This is the cheapest adoption with the clearest payoff and needs no agent in the loop.

## Prior evidence decomposed (why "codex kept saying it was bad")

- **v5 sealed DO_NOT_ADOPT**: causally void — all 68 guessless MCP calls were cancelled client-side; no engine output ever reached the agent (confirmed by the project's own T001 audit).
- **v7/v8**: evaluator infrastructure died at cell 1 (JSONL parser bug; provider schema rejection). One-shot no-retry rules sealed each as permanent NO_GO.
- **v9**: the agent's answer was exactly correct with zero false-completeness; NO_GO only because a frozen 160k token cap was exceeded.
- **v10/v11**: guessless-artifact arms exactly correct, control wrong; production cell correct; NO_GO because n=1 cannot clear conjunctive gates written for 72 cells.
- **fast-value-validation pair one**: the only valid causal pair pre-dating this run — output arrived, was materially used, both arms false-completed identically; locked rule converted that tie into an irreversible DO_NOT_SHIP.

The pattern: protocols were built so that any failure anywhere — harness, caps, sample size — resolved to a permanent negative, and immutability rules forbade retrying. The verdicts were rule-correct and evidence-poor. This run reversed the design: small ground-truthed units, mechanical verification, retry-by-fresh-dispatch, director adjudication of raw receipts — and it produced a fixable defect list instead of a wall of NO_GOs, in 43 minutes.

## What was NOT established here

- No statistically powered agent-value claim in either direction (A/B was n=1 per arm, one repo, one model family).
- No measurement on repos large enough that exhaustive grep is impractical — the setting where guessless's guarantee should matter most.
- No re-test of the MCP transport reliability issue that voided v5 (this run used the CLI, which was flawless across ~80 invocations).
