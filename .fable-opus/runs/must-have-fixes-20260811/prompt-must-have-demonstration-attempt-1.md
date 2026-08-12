Fable-Opus-Unit: must-have-fixes-20260811/must-have-demonstration
Fable-Opus-Timeout-Minutes: 45

## Goal

Execute the must-have demonstration exactly as specced by the T006 Judge: scope-resolved symbol truth at repo scale, where mechanical grep provably cannot partition same-name bindings. Working directory: the guessless workspace (current checkout; engine at HEAD with D1–D5 fixes; dist freshly built — do NOT rebuild).

Corpus (READ-ONLY): /Users/jacksm5pro/dev/open-source/markless at commit 931f054444a41c0527dfa77f812fa49e87df3b8f; its working tree must stay byte-clean. Input set (mechanical): the 635 files from `git -C /Users/jacksm5pro/dev/open-source/markless ls-files '*.ts' | grep '^packages/'` — committed only, no untracked dist trees.

Two target bindings:
- **S1** `deserializeGraphValue` declared in `packages/serializer/src/value-decode.ts`, re-exported at `packages/serializer/src/value.ts:120`. DECOY: the distinct local `async function deserializeGraphValue` at `packages/web/src/payload-graph-construct.ts:148` with call sites at lines 68, 134, 137, 139.
- **S2** `ASYNC_BOUNDARY_ARM` declared at `packages/serializer/src/async-boundary-arm.ts:7`. Decoys: prefix neighbors `ASYNC_BOUNDARY_ARM_MIN/_PENDING/_MAX`; ~30 files import via `@markless/serializer` package specifiers (the D1 class).

Protocol per symbol:
1. **GROUND TRUTH** by bounded hand-audit: classify every hit of `rg -n '\b<sym>\b'` over the input set as target-binding or decoy-binding by reading imports/declarations; write `ground-truth.json` (file, line, class). The packages/serializer subset for S2 must agree with the sealed v1 q03 6-site ground truth in `docs/evidence/adoption-eval-fable-v1/`.
2. **BASELINE**: record the verbatim rg command and its full hit list; score `baselineDecoyHits` and `baselineTrueHits`; grep's answer is the undifferentiated union.
3. **GUESSLESS**: using the existing CLI (pattern: `docs/evidence/adoption-eval-fable-v2/raw-markless/run-markless-v2.mjs`), prepare the full 635-file set, derive anchors via `resolveBinding` only (no hand anchors), run `referencesOf` for each target binding; check in receipts, timings, and the query index.
4. **SCORE** mechanically in `score-demo.mjs`. PASS requires ALL of:
   - P1: zero decoy sites in any `results` array.
   - P2: zero silent misses — every ground-truth target site either returned in results or covered by a causally specific unresolved entry naming its file and failing specifier/reason.
   - P3: results cover 100% of target sites inside `packages/serializer/**`, including all 6 sealed q03 sites for S2.
   - P4: `baselineDecoyHits > 0` for S1 (grep provably cannot produce the partition).
   - P5: total prepare+query wall time <= 10 minutes.

FALSIFIERS — the must-have claim is DISPROVED; stop and return status "blocked" leading with the falsifying receipt if any fires:
- F1: any decoy site appears in results (spurious scope resolution).
- F2: any target site silently absent — neither returned nor named (honesty contract broken at scale).
- F3: word-boundary rg alone yields zero decoy hits for both symbols (ambiguity does not exist; grep suffices).
- F4: the 635-file input changes any answer within the sealed v1/v2 serializer-scope ground truth (answer instability under input growth).
- F5: prepare+queries exceed 10 minutes wall, twice (large-repo claim fails operationally).

A fired falsifier is a valid, honest outcome — do not soften scoring to pass.

Output, all under `docs/evidence/adoption-eval-fable-v2/demonstration/`: `report.md` (leading with PASS or the fired falsifier, per-symbol partition table grep-vs-guessless, receipt sizes and timings), `ground-truth.json` per symbol, receipts, run script, `score-demo.mjs` (exits non-zero unless all of P1–P5 hold), `scores.json`.

## File contract

- `docs/evidence/adoption-eval-fable-v2/demonstration/**`

## Forbidden moves

- Never write to the markless repo, `docs/evidence/adoption-eval-fable-v1/**`, existing v2 files outside `demonstration/`, or any package source. Why: read-only corpus, immutable eras, shipped artifact under test.
- Do not rebuild guessless. Why: HEAD dist is the artifact under test.
- Do not hand-tune anchors or scoring to reach PASS. Why: a demonstration that cannot fail proves nothing.

## Verification

```verify
test -f docs/evidence/adoption-eval-fable-v2/demonstration/report.md
node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs
test -z "$(git -C /Users/jacksm5pro/dev/open-source/markless status --porcelain)"
test -z "$(git status --porcelain -- packages/ docs/evidence/adoption-eval-fable-v1/)"
pnpm test
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, a falsifier fires (expected blocked path — lead with the falsifying receipt), or you need a file outside the contract, return status "blocked" with the question or falsifier in open_questions instead of improvising.