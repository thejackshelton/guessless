# Guessless must-have fixes

## Objective

Fix the four critical defect classes documented in `docs/evidence/adoption-eval-fable-v1/verdict.md`, re-validate the honesty contract against the same ground-truth corpora, and demonstrate one repo class where guessless is a must-have tool — with every Worker slice dispatched through the fable-opus cockpit and the run driven at a 15-minute /loop cadence.

## Original Request

"Ok go in and improve all the critical issues of guessless, use fable opus cockpit and 15m /loop. Get us to a state where we are confident this is a must have tool for some repos."

## Intake Summary

- Input shape: `specific`
- Audience: Guessless maintainer and agent-tool consumers in the markless/versionless/frameless family
- Authority: `requested`
- Proof type: `metric`
- Completion proof: zero missed-and-unnamed sites across the re-run v1 ground truth; per-defect regression tests green in the full suite; one demonstration receipt where baseline tooling misses or cannot run and guessless answers with an honest receipt
- Goal oracle: the adoption-eval-fable-v2 re-trial plus the demonstration (see below)
- Likely misfire: patching the four defects to satisfy the exact v1 fixtures instead of the defect class; or declaring "must-have" from the honesty re-trial alone without a scenario a grep-capable agent cannot serve
- Blind spots considered: `vp pack` rebuilds every package's dist (allowed_files must cover it); no git repo exists (T001 fixes this first, enabling cockpit worktree isolation); D3 may be a design choice — the fix may be receipt vocabulary rather than mutation analysis, but README and receipt must agree; sealed evidence is immutable; small-repo A/B already showed cost-without-lift, so the must-have claim needs a scenario grep cannot serve
- Existing plan facts: defect classes D1–D4 with suggested fail-closed fixes and raw receipt evidence live in `docs/evidence/adoption-eval-fable-v1/` (verdict.md, raw-markless/, raw-versionless/); execution must use fable-opus cockpit packets; cadence is a 15m /loop

## Goal Oracle

The oracle for this goal is:

`An adoption-eval-fable-v2 re-trial over the sealed v1 ground-truth corpora shows zero missed-and-unnamed sites (every ground-truth site either returned or named in unresolved), full workspace verification is green (pnpm build/test/typecheck/lint), and one receipted demonstration shows guessless materially beating baseline tooling on a repo class where the completeness guarantee matters — judged against a stated falsifier.`

The PM must keep comparing task receipts to this oracle. Planning, discovery, a passing tiny slice, or a clean-looking board is not enough. The goal finishes only when a final Judge audit maps receipts and verification back to this oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Establish the git baseline, complete the three fix slices (D1; D2+D3; D4) with class-level regression tests, re-run the v1 honesty trials as a fresh v2 evidence bundle, then select and execute one falsifiable must-have demonstration, and finish with the final audit. Continuous execution: after each verified Worker package, advance immediately to the next.

## Non-Negotiable Constraints

- Every Worker slice is dispatched through the fable-opus cockpit (`opus-worker` packets with file contracts and verify fences); once T001 lands a git baseline, prefer `opus-worker-isolated` for engine slices.
- The run is driven at a 15-minute /loop cadence: `/loop 15m /goal Follow docs/goals/guessless-must-have-fixes/goal.md.`
- Sealed evidence is immutable: `docs/evidence/oracle-part-3-*`, `docs/evidence/guessless-*`, `docs/evidence/adoption-eval-fable-v1/`, and all goal state under other goal slugs. v2 evidence goes to `docs/evidence/adoption-eval-fable-v2/`.
- The fail-closed receipt contract holds: no bare result lists, closed unresolved-reason enumeration (new reasons are added by name, never "other"), symbol-anchored citations, JS/TS/JSX/TSX-only via Yuku, no second parser.
- Fixes must cover the defect class, not the fixture: each regression suite includes at least one adversarial variant beyond the exact v1 evidence case.
- No model-backed external spend without explicit owner approval recorded in a receipt.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection; a safe Worker task can almost always be activated. Do not stop after a single verified Worker package while queued packages remain. Mark externally-blocked slices blocked with a receipt and continue local work.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible — not tiny. The board's Worker packages are already cut as the largest safe slices (D2+D3 share one reference-completeness slice). Do not subdivide them further unless verification fails twice or a stop_if fires.

## Board Health

If the board looks stale or inconsistent, run:

```bash
node /Users/jacksm5pro/.claude/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/guessless-must-have-fixes
```

## Canonical Board

Machine truth lives at:

`docs/goals/guessless-must-have-fixes/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/guessless-must-have-fixes/goal.md.
```

Driven at the requested cadence:

```text
/loop 15m /goal Follow docs/goals/guessless-must-have-fixes/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter and the GoalBuddy execution contract (`references/goal-execution.md` in the goal-prep skill) when available.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available; mention a newer version without blocking.
4. Re-check the intake, especially the likely misfire (fixture-level patches masquerading as class-level fixes).
5. Work only on the active board task; dispatch Worker tasks as fable-opus cockpit packets and verify receipts against raw evidence before accepting.
6. Write a compact task receipt; update the board.
7. Advance to the next queued package immediately after a verified slice.
8. Review at phase, risk, rejected-verification, ambiguity, or final-completion boundaries.
9. Finish only with the T999 Judge audit recording `full_outcome_complete: true`.
