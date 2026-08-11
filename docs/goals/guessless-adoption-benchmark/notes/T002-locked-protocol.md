# T002 locked oracle-part-3-v3 protocol

This note is a verbatim durable expansion of the T002 Judge evidence used by active Worker T003. It supplies the exact details that the compact board receipt summarized.

## Identity and parity

- Identity: `oracle-part-3-v3`.
- Protocol schema: `guessless.evaluation-protocol/v3`.
- Fixture: `packages/evaluation/fixtures/oracle-part-3-v3`.
- Final evidence: `docs/evidence/oracle-part-3-v3`.
- Staging prefix: `docs/evidence/.staging-oracle-part-3-v3-`.
- V1 and v2 remain immutable history.
- V3 input, `ground-truth.json`, and `response.schema.json` are byte-identical to v2.
- Preserve v2 model, prompts, system instruction, Codex flags, environment policy, 16-tool-call limit, 300-second timeout, scoring semantics, and arm parity except for the explicitly listed v3 changes.

## Exact order

All 36 cells execute sequentially once, without retry, replacement, resume, reordering, deletion, efficacy stopping, or selective omission:

1. `r01-rename-control`
2. `r01-rename-guessless`
3. `r01-delete-guessless`
4. `r01-delete-control`
5. `r01-reach-control`
6. `r01-reach-guessless`
7. `r02-delete-control`
8. `r02-delete-guessless`
9. `r02-reach-guessless`
10. `r02-reach-control`
11. `r02-rename-guessless`
12. `r02-rename-control`
13. `r03-reach-control`
14. `r03-reach-guessless`
15. `r03-rename-guessless`
16. `r03-rename-control`
17. `r03-delete-control`
18. `r03-delete-guessless`
19. `r04-rename-guessless`
20. `r04-rename-control`
21. `r04-delete-control`
22. `r04-delete-guessless`
23. `r04-reach-guessless`
24. `r04-reach-control`
25. `r05-delete-guessless`
26. `r05-delete-control`
27. `r05-reach-control`
28. `r05-reach-guessless`
29. `r05-rename-control`
30. `r05-rename-guessless`
31. `r06-reach-guessless`
32. `r06-reach-control`
33. `r06-rename-control`
34. `r06-rename-guessless`
35. `r06-delete-guessless`
36. `r06-delete-control`

This gives every task six pairs, three control-first and three Guessless-first; every task occupies each round position twice; globally nine pairs are control-first and nine Guessless-first.

## Validity and failure topology

A cell is valid only when spawn returns, status is zero, signal is null, no timeout occurs, stdout is complete LF-terminated parseable JSONL, exactly one terminal schema-valid response is replayed, counts are finite safe nonnegative integers, tool calls are at most 16, no secret pattern occurs, argv/environment/fixture postflight match authority, control has zero Guessless invocations, and treatment has at least one Guessless invocation. A pair is valid only when both cells are valid.

Cell-local transport, process, timeout, transcript, response-schema, tool-budget, or arm-compliance failures become sealed invalid cells and the next preregistered cell still runs. Authority/preflight mutation, secret exposure, or inability to durably write/seal evidence is run-fatal: preserve an honest non-reusable attempt, mark the remaining suffix unrun, prohibit retry, and classify `INCONCLUSIVE`.

`reportedTotalTokens` is the last `turn.completed` input tokens plus output tokens, validated only as a finite nonnegative safe integer. It is recorded per cell, never summed across turn events, never treated as marginal context cost, and never gates validity. Token ratios are descriptive safeguards only. `durationMs` includes transport; `toolCalls` follows transcript `item.started` semantics.

## Correctness and exact inference

A correct cell is valid and has `reportedSiteIds` exactly equal to planted sites, `unresolvedSiteIds` exactly equal to ground-truth unresolved sites, no misses or false positives, and status `complete` when truth has no unresolved sites or `partial` when it does. `refused` is incorrect. False-completeness is one when status is `complete` while any planted site is missed or any ground-truth unresolved site remains.

For valid pairs define correctness delta as `treatmentCorrect - controlCorrect`. `W`, `L`, and `T` count `+1`, `-1`, and `0`. Ties are reported and excluded from sign-test `n`. If `n=0`, every directional p-value is 1. Otherwise:

- exact one-sided treatment p-value: `sum(k=W..n, C(n,k)/2^n)`;
- exact one-sided harm p-value: substitute `L` for `W`;
- exact two-sided value: `min(1, 2 * sum(k=0..min(W,L), C(n,k)/2^n))`.

No asymptotic approximation is allowed.

Efficiency is evaluated only on valid pairs where both cells are correct. Report duration ratio Guessless/control, reported-token ratio Guessless/control when both are positive, and tool-call delta Guessless-control. Report per-task and overall medians, duration geometric mean, and exact sign p-values; exact numeric ties are excluded only from the sign-test denominator.

For each scalar paired distribution, compute an exact distribution-free 95% median interval by sorting all `n` observations including ties and choosing the largest `k` with `1 - 2 * sum(j=0..k-1, C(n,j)/2^n) >= 0.95`; return `[x[k], x[n-k+1]]` using one-based indexing. If no `k` exists, return unbounded endpoints. Use integer binomial arithmetic and deterministic comparisons; no random bootstrap or floating nondeterminism.

## Mechanical decision

Decision precedence is `INCONCLUSIVE`, then `ADOPT`, then `DO_NOT_ADOPT`, else `PILOT`.

### INCONCLUSIVE

Apply before all other decisions when fewer than 16 valid pairs overall, fewer than five valid pairs for any task, a run-fatal condition occurs, replay disagrees, or required metrics cannot be computed.

### ADOPT

`ADOPT` permits reversible integration into Markless, Frameless, Versionless, and comparable siblings subject to each repository's tests; it is not universal causal proof.

After validity, require zero treatment-added false-completeness and no task with fewer correct treatment cells than controls, plus either:

1. correctness `W - L >= 3` with one-sided exact `p <= 0.05`; or
2. `W = L = 0`, at least 16 both-correct pairs and at least five per task, overall median duration ratio `<= 0.80`, upper exact 95% median-duration bound `< 1`, every task median duration ratio `<= 1.10`, median tool-call delta `<= 1`, and median reported-token ratio `<= 1.25`.

### DO_NOT_ADOPT

After validity, apply if any of these holds:

1. treatment adds any false-completeness;
2. correctness `L - W >= 3` with exact harm `p <= 0.05`; or
3. `W = L = 0`, at least 16 both-correct pairs, and either:
   - median duration ratio `>= 1.50` with lower exact 95% bound `> 1`; or
   - median tool-call delta `>= 3` with lower exact 95% bound `> 0`.

### PILOT

Every other sufficiently valid outcome is `PILOT`: integrate one sibling only, measure real work, and reassess before broader rollout.

## Evidence topology

The sealed v3 bundle contains exactly 82 files: `manifest.json` plus 81 manifest members comprising `protocol.json`, `commands.json`, `scores.json`, `benchmarks.json`, `decision.json`, `replay.json`, `summary.md`, `raw/runs.jsonl`, `raw/calibration.jsonl`, and stdout/stderr files for all 36 cells.

Replay derives cell validity, scores, uncertainty, benchmarks, and decision from immutable protocol, fixture authority, and raw transcripts rather than trusting generated projections. Calibration mutation-proves order, identity, parity, continuation, token-record-only semantics, topology, replay, statistics, decision thresholds, manifest coverage, secrets, no retries, and byte-identical restoration.
