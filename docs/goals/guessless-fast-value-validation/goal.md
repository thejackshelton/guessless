# Guessless Fast, High-Value Validation

## Objective

Reach a decision-grade `SHIP_PILOT` or `DO_NOT_SHIP_FOR_NOW` verdict on Guessless using the least validation time that still measures causal value on authentic real-agent coding work.

## Original Request

"Make a new goal where the time spent validating is as short as possible and full of value."

## Intake Summary

- Input shape: `recovery`
- Audience: Guessless maintainer deciding whether to pilot the tool with coding agents
- Authority: `approved`
- Proof type: `decision`
- Completion proof: an independent Judge issues a binary adoption decision from valid focused-test-backed pairs under the locked sequential policy
- Goal oracle: paired real-agent patches show whether concrete pre-edit Guessless results change tested correctness or efficiency
- Likely misfire: spending time on harnesses, seals, setup, broad suites, optional-tool adoption, or artifact polish instead of obtaining causal evidence
- Blind spots considered: test executability, solution leakage, material tool use, prompt parity, binary stopping policy, and the cost of over-validation
- Existing plan facts: the v4 study is sealed but decision-inadequate; do not extend, edit, or count it as new evidence

## Goal Oracle

The oracle is:

`Two concordant valid pairs justify an early binary decision; otherwise one tie-breaker pair produces the final binary decision. Every counted pair has a hidden solution, an exact preflighted focused test, complete patches, and traceable pre-edit Guessless use in treatment.`

The PM must keep comparing receipts to this oracle. Agent invocation, snapshot creation, broad activity, or a polished evidence bundle is not proof.

## Goal Kind

`recovery`

## Current Tranche

Run two authentic paired tasks first. Run a third tie-breaker only if the first two do not support the same decision. Use no more than three tasks and six fresh `gpt-5.6-sol` coding-agent cells.

Validation overhead is hard-capped at 20 minutes when the two-pair early-stop rule fires and 30 minutes when the tie-breaker is required, excluding the real agents' implementation time.

Before spending agent cells on a candidate, perform one direct, hard-capped preflight in its actual disposable tree:

1. Historical solution and original Git history are absent.
2. No absolute dependency link can expose the source repository.
3. The exact focused test command starts and passes without installs or repairs.
4. The task has a task-relevant structural question Guessless can answer before editing.

The preflight gets five minutes maximum. A failing candidate is discarded before launch; do not repair its environment, build a runner, or substitute weaker validation.

The treatment context explains Guessless and requires, before the first edit, a complete snapshot plus at least one narrower task-relevant structural query. Material use counts only when the agent cites a concrete result in an implementation-scope, target, or test decision. Snapshot invocation alone never counts.

After each pair, spend at most five minutes on a read-only Judge audit of semantic correctness, focused-test completion, false completeness, material-use timing, wall time, and counted tools. Do not run broad suites when the focused test already discriminates the patch.

## Locked Decision Policy

A valid pair is a treatment win when treatment is tested and semantically correct while control is not, or when both are equally tested/correct and treatment reduces wall time or counted tools by at least 20% without a regression. A control win is the converse or any treatment false-completion event. Otherwise the pair ties.

- After pair two, issue `SHIP_PILOT` early only if treatment wins both pairs, loses none, has no false completion, and both treatments materially used a pre-edit Guessless result.
- After pair two, issue `DO_NOT_SHIP_FOR_NOW` early if control wins both, treatment false-completes, or both treatments fail material pre-edit use.
- Otherwise run exactly one tie-breaker.
- After pair three, issue `SHIP_PILOT` only if treatment has at least two wins, no control win, no treatment false completion, and material pre-edit use in at least two treatments. Otherwise issue `DO_NOT_SHIP_FOR_NOW`.

`DO_NOT_SHIP_FOR_NOW` means the pilot has not earned adoption, not that the product is permanently rejected. `INCONCLUSIVE` is not a permitted terminal label for this bounded adoption decision.

## Non-Negotiable Constraints

- Use authentic historical JavaScript/TypeScript/JSX/TSX maintenance tasks from at least two repositories.
- Use real same-model control/treatment coding agents, not simulations or offline scoring.
- Keep control/treatment product tree, prompt, model, environment, and test command identical; treatment-only differences are the frozen Guessless context and MCP.
- Use a product-only disposable baseline with no original `.git`, solution object, other arm, or absolute source-repository dependency link.
- Do not install dependencies or create/edit a harness, runner, evaluator, fixture, package manifest, lockfile, product file, or prior evidence.
- Capture only decision-bearing evidence: raw transcript, final response, complete binary patch, exact focused-test output, wall time, tool count, and treatment result-use trace.
- Do not spend time on elaborate seals, dashboards, broad suites, or redundant checks.
- Stop a candidate before launch if the five-minute preflight cannot prove secrecy and runnable focused tests.
- Never retry or repair a launched cell. Preserve invalidity honestly and apply the locked decision policy.

## Stop Rule

Stop only when the final Judge records `full_outcome_complete: true` and one binary decision: `SHIP_PILOT` or `DO_NOT_SHIP_FOR_NOW`.

Do not stop on a plan, one pair, or an `INCONCLUSIVE` label unless the locked early-stop rule has already produced a binary decision.

## Slice Sizing

Each paired task is one useful experimental slice: preflight, two agent cells, compact capture, and one five-minute audit. Do not split artifact capture or metric bookkeeping into separate tasks.

## Board Health

```bash
node /Users/jacksm5pro/.codex/plugins/cache/goalbuddy/goalbuddy/0.4.3/skills/goal-prep/scripts/check-goal-state.mjs docs/goals/guessless-fast-value-validation
```

## Canonical Board

Machine truth lives at `docs/goals/guessless-fast-value-validation/state.yaml`.

## Run Command

```text
Codex: /goal Follow docs/goals/guessless-fast-value-validation/goal.md.
Claude Code: /goalbuddy Follow docs/goals/guessless-fast-value-validation/goal.md.
```

## PM Loop

1. Read this charter and the GoalBuddy execution contract.
2. Work only on the active task in `state.yaml`.
3. Enforce the five-minute candidate preflight and five-minute pair audit caps.
4. Record a compact receipt and advance immediately.
5. Apply the locked early-stop or tie-breaker rule without changing thresholds after seeing results.
6. Finish only through T999 with `full_outcome_complete: true` and a binary adoption decision.
