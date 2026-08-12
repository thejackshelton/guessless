# Guessless harness integration

## Objective

Wire the four-layer guessless integration — documentation block, per-repo skill, stop-hook claim gate, CI reproduce check — into markless, versionless, and frameless, with the shared gate machinery shipped from the guessless repo. Every Worker slice dispatches through the fable-opus cockpit; the run is driven at a 15-minute /loop cadence.

## Original Request

"Ok, go ahead and start adding it now. Use fable opus cockpit with goal prep in 15m /loop." — following the agreed layering: agents.md documents, the skill remembers, the stop-hook enforces, CI verifies with zero agent cooperation; if only one thing lands, it is the hook.

## Intake Summary

- Input shape: `specific`
- Audience: Jack's agent harnesses (Claude Code and Codex) across the -less family
- Authority: `requested`
- Proof type: `artifact`
- Completion proof: all files in place per the oracle; gate test suite green; live hook-fire test passes; no target-repo config clobbered
- Goal oracle: see state.yaml — per-repo per-layer file evidence plus a mechanically firing gate
- Likely misfire: clobbering markless's existing `.claude` config; committing in target repos; shipping docs layers while the enforcing hook silently never fires
- Blind spots: cockpit scope guard vs cross-repo absolute-path contracts (PM fallback defined); markless concurrent writers (changes stay uncommitted, additive only); Stop-hook stdin contract; versionless offline conventions; skill frontmatter validity
- Existing plan facts: gate machinery centralized in guessless (`scripts/claim-gate.mjs`, `scripts/reproduce-check.mjs`); target repos reference it by absolute path; repo states scanned at prep (markless has `.claude`, the others do not)

## Goal Oracle

`Every target repo carries the AGENTS.md block, a valid skill, and a Stop hook wired into valid settings.json preserving pre-existing keys; guessless ships tested claim-gate and reproduce-check scripts; the Judge's live hook-fire test blocks an unreceipted completeness claim and passes a receipted one; full workspace verification stays green.`

Planning, partial layers, or good-looking docs do not complete this goal — the hook must demonstrably fire.

## Goal Kind

`specific`

## Current Tranche

T001 gate machinery in guessless → T002 markless → T003 versionless → T004 frameless → T999 audit. Continuous execution; PM fallback for any task the cockpit scope guard cannot express (recorded as a deviation on the receipt).

## Non-Negotiable Constraints

- Worker dispatch through fable-opus cockpit packets; 15m loop: `/loop 15m /goal Follow docs/goals/guessless-harness-integration/goal.md.`
- Never commit or push in markless, versionless, or frameless; changes stay in working trees for owner review. AGENTS.md edits are append-only marked sections; markless `.claude/settings.json` is merged additively with every existing key preserved.
- versionless additions are offline-only, respecting its consent conventions.
- guessless changes go through the normal verify gate and are committed in guessless.

## Stop Rule

Stop only when the T999 audit proves the full outcome with `full_outcome_complete: true`. Blocked cross-repo units fall back to PM execution, not to goal stoppage.

## Board Health

`node /Users/jacksm5pro/.claude/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/guessless-harness-integration`

## Canonical Board

`docs/goals/guessless-harness-integration/state.yaml` — if this charter and the board disagree, the board wins.

## Run Command

```text
/goal Follow docs/goals/guessless-harness-integration/goal.md.
```

Driven at the requested cadence:

```text
/loop 15m /goal Follow docs/goals/guessless-harness-integration/goal.md.
```

## PM Loop

Standard GoalBuddy execution contract; dispatch Workers as cockpit packets, verify receipts against raw evidence (files and diffs, not prose), record receipts, advance continuously, finish only through the T999 audit.
