# Guessless adoption benchmark

## Objective

Produce a conclusive, decision-grade same-model benchmark of coding agents with and without Guessless so the owner can decide immediately whether to integrate Guessless into Markless, Frameless, Versionless, and related repositories.

## Original Request

`Do a conclusive benchmark so we can know whether or not we need to put it into markless, frameless, versionless, etc. asap`

## Intake Summary

- Input shape: `specific`
- Audience: the maintainer deciding whether to adopt Guessless across sibling projects
- Authority: `requested`
- Proof type: `metric` and `decision`
- Completion proof: a preregistered repeated paired benchmark with sealed raw transcripts, offline verification, effect sizes and uncertainty, and an explicit adopt/pilot/do-not-adopt decision tied to fixed criteria
- Goal oracle: both arms complete enough valid repeated trials to calculate the declared decision metrics without sentinel or invalid-cell substitution
- Likely misfire: calling another single run, a token-accounting failure, or a synthetic-only number “conclusive” without a decision rule
- Blind spots considered: Codex baseline context makes total-token caps misleading; order and warm-cache effects require counterbalancing; repeated calls cost time/tokens; sibling-repo adoption needs a bounded decision rather than universal causal claims; tool invocation and prompt parity must be mechanically proven
- Existing plan facts: preserve v1/v2 as immutable history; use a new versioned protocol; same model and task prompt in paired arms; only Guessless access differs; add sealed benchmark evidence; never overwrite or reinterpret failed historical attempts

## Goal Oracle

The oracle is:

`A separately versioned benchmark completes its preregistered repeated paired design, passes replay/calibration and manifest verification, reports sites missed, false-completeness, validity, time, tokens, and tool use with uncertainty, and emits an evidence-backed sibling-repository adoption decision under the declared stopping rule.`

The goal finishes only when a final Judge or PM audit maps current evidence to that oracle and records `full_outcome_complete: true`.

## Goal Kind

`specific`

## Current Tranche

Audit the current v2 harness failure, preregister the smallest statistically credible repeated paired design, implement and mutation-prove the new protocol, run it once without retries or selective omission, seal and analyze the complete evidence, and publish the adoption decision.

## Non-Negotiable Constraints

- Preserve all oracle-part-3-v1 and oracle-part-3-v2 bytes and reports unchanged.
- Use a fresh evidence identity and separate fixture/staging/final paths.
- Use identical model, prompt, fixture bytes, budgets, scoring, and environment between paired arms; only Guessless MCP access may differ.
- Predeclare repetitions, order/counterbalancing, validity rules, token-accounting semantics, stopping rule, adoption thresholds, and inconclusive fallback before any live call.
- Do not use reported total tokens as a validity cap unless the cap accounts for Codex's fixed context; cap actionable output/reasoning or remove the invalid total-token gate while still recording total usage.
- Seal every attempted cell and every raw transcript; no retry, cherry-picking, tuning, or post-hoc task deletion.
- A decision may be scoped to “pilot in sibling repos” rather than claiming universal agent improvement, but it must follow the preregistered evidence rule.
- Keep credentials and secret values out of evidence.

## Stop Rule

Stop only when the benchmark yields a verified adoption decision or when the preregistered design itself reaches its explicit inconclusive terminal condition after all authorized repetitions. Do not stop at protocol design, implementation, or partial evidence while safe authorized work remains.

## Canonical Board

Machine truth lives at `docs/goals/guessless-adoption-benchmark/state.yaml`.

## PM Loop

Continue the active task, record a receipt, advance immediately to the next safe package, and run the final GoalBuddy stop gate only after the full decision artifact is current and verified.
