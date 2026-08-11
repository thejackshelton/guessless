# Guessless sibling-repository adoption decision

## Recommendation

Do not integrate Guessless into Markless, Frameless, Versionless, or comparable sibling repositories now.

This is a current, scoped `DO_NOT_ADOPT` decision for reversible sibling-repository integration. It is not a universal claim that Guessless can never help, and it is not a permanent prohibition on a future materially different implementation and separately preregistered evaluation.

## Decision-grade result

The sealed `oracle-part-3-v5` protocol (`guessless.evaluation-protocol/v5`) used `gpt-5.6-sol` with Codex 0.146.0. It ran six repetitions of each of three synthetic structural-analysis tasks in counterbalanced order: 36 completed cells, 18 valid control/Guessless pairs, six valid pairs per task, no run-fatal condition, and 68 treatment versus zero control Guessless invocations.

Correct cells by task were:

| Task   | Control | Guessless |
| ------ | ------: | --------: |
| Rename |     5/6 |       4/6 |
| Delete |     0/6 |       0/6 |
| Reach  |     4/6 |       6/6 |

Across pairs, Guessless won three, lost two, and tied thirteen. The directional sample was five; the exact sign-test probabilities were treatment `p=0.5`, harm `p=0.8125`, and two-sided `p=1`. The reach result is genuinely positive—Guessless was correct in all six reach cells versus four controls—but it does not override the frozen correctness-safety rule.

Guessless produced two false-complete cells versus one control false-complete cell, so it added false completeness. It also regressed rename correctness from five correct controls to four correct treatment cells. Added false completeness directly triggers the preregistered `DO_NOT_ADOPT` rule; the rename regression independently violates the no-task-regression condition required for adoption. The sealed [decision](oracle-part-3-v5/decision.json) therefore reports `DO_NOT_ADOPT`.

## Correctness-conditioned efficiency

Efficiency was evaluated only for the seven pairs in which both arms were correct: three rename pairs and four reach pairs; there were no both-correct delete pairs.

| Metric | Guessless/control result | Exact interval or sign evidence |
| ------ | -----------------------: | ------------------------------- |
| Duration | median ratio 1.258031; geometric mean 1.419438 | 95% interval 1.036339–2.003532; all 7 slower; two-sided `p=0.015625` |
| Reported final-turn tokens | median ratio 1.598109 | 95% interval 0.946294–1.731603; 6 of 7 higher; two-sided `p=0.125` |
| Tool calls | median delta +5 | 95% interval +1–+7; all 7 higher; two-sided `p=0.015625` |

Aggregate control/Guessless usage across all cells was 748,146/948,660 ms, 1,422,673/1,936,016 reported final-turn tokens, and 56/120 tool calls. Reported tokens are Codex final-turn fixed-context usage, not marginal task cost; aggregate usage is descriptive and does not replace the paired correctness-conditioned analysis.

## Deletion convention

The frozen deletion oracle treats `delete/state.ts:1:12` as the target declaration, not as a requested read/write use, so it is excluded from resolved sites. The requested resolved sites are the assignment at `delete/state.ts:3:2` and reads at `delete/consumers.ts:2:39` and `delete/alias.ts:2:43`; the unresolved computed-property boundary is `delete/dynamic.ts:3:55`. Every deletion answer missed that exact unresolved boundary, and answers that included the declaration received a false positive under the preregistered convention. This convention explains the 0/6 versus 0/6 deletion result, but it does not create the decisive added false completeness, which came from unambiguous rename coordinates.

## Scope and limitations

The benchmark covers three small synthetic TypeScript fixtures with one fixed model and Codex version. Sequential execution may retain order, warm-cache, and transport effects despite counterbalancing. Model output is nondeterministic. Duration includes transport overhead, transcript events define tool-call counts, and reported tokens are not marginal cost. Repetition estimates reliability on these fixtures; it does not establish universal repository-level causality.

The recommendation therefore governs integration into the named sibling projects now. The positive reach result remains useful engineering evidence, but the benchmark does not support accepting added false completeness or rename regression in exchange for it.

## Sealed evidence and hashes

The v5 bundle contains 82 files: one manifest covering 81 members. Replay and calibration reproduce the sealed analysis.

| File | SHA-256 |
| ---- | ------- |
| `manifest.json` | `19171782e5c4a6713dcbdab676cba191de65084e5eed90c42aeb77a14e82acef` |
| `raw/runs.jsonl` | `0916f35cb25a130f1117a6d88904d54dae2b0843d89a34840d9a4f256b49a846` |
| `scores.json` | `391b4c7deb2e6efe0873bf8eb0d5936387d9185f8c683c5b5fc0ec6f3ada6357` |
| `decision.json` | `6a22405fee38d56c1ed68ca08ccd61669f8deb52d81097bc20c121dfee3a630d` |
| `replay.json` | `cec5761ae5a205bd57b942065a87039c6c5187e9a485015ce892ca9c66fc4d68` |
| `raw/calibration.jsonl` | `313a9e74d8d8053aa5a0570034ab4862768101d231d31df94f720f73c48887f6` |

Primary artifacts: [summary](oracle-part-3-v5/summary.md), [decision](oracle-part-3-v5/decision.json), [benchmarks](oracle-part-3-v5/benchmarks.json), [replay](oracle-part-3-v5/replay.json), and [manifest](oracle-part-3-v5/manifest.json).

The invalid histories remain immutable. The [v3 attempt](oracle-part-3-v3-attempt.md) had 36 failed cells and zero valid pairs; it is unpromoted historical evidence and cannot support adoption. The mechanically reproducible v4 result is not decision-grade because its model-visible paths and oracle IDs disagreed; see the [v4 audit](oracle-part-3-v4-audit.md). Neither v3 nor v4 may be retried, resumed, promoted, or rescored.
