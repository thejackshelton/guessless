# Oracle part 3 v4 audit

The sealed v4 evidence is mechanically reproducible but is not decision-grade. This is a read-only audit: no v4 transcript was retried, rescored, promoted, replaced, or mutated.

All 36 cells ran, forming 18 pairs. The bundle recorded 202 tool calls, 3,509,068 reported final-turn tokens, and 1,785,499 ms. Treatment cells made 83 Guessless calls and control cells made none. The mechanical result was `DO_NOT_ADOPT`, with zero both-correct pairs.

That result is invalid for product adoption because the model-visible scratch directory contained task files directly while the locked truth expected task-prefixed IDs. All 232 reported IDs were unprefixed, so scoring systematically classified otherwise relevant answers as misses and false positives. The v4 field contract also left resolved results and unresolved boundaries ambiguous enough to permit overlap.

No deterministic replay-only correction is defensible: changing path and field meanings after seeing outcomes would be post-hoc. A fresh separately versioned v5 run is required. V5 must expose `scratch/<task>/` identically to shell tools and Guessless, require task-prefixed IDs, make reported and unresolved fields disjoint, and validate its locked coordinates from fixed source bytes and documented lexemes independently of Guessless, parser output, v4 outputs, or model outcomes.
