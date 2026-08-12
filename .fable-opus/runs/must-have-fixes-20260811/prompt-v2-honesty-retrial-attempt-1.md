Fable-Opus-Unit: must-have-fixes-20260811/v2-honesty-retrial
Fable-Opus-Timeout-Minutes: 45

## Goal

Re-run the adoption-eval-fable-v1 honesty trials against the fixed guessless engine and produce the `adoption-eval-fable-v2` evidence bundle. This is the goal's oracle measurement: **zero missed-and-unnamed sites** — every ground-truth site from the v1 trials must now be either returned in `results` or named in `unresolved` with a closed reason.

Working directory: the guessless workspace (current checkout — the engine at HEAD contains the D1–D4 fixes; dist is freshly built; do NOT rebuild). The v1 evidence at `docs/evidence/adoption-eval-fable-v1/` is READ-ONLY input: `markless-report.md` and `versionless-report.md` contain the hand-audited ground-truth site tables; `raw-markless/` and `raw-versionless/` contain the exact request documents, filesets, and helper scripts (`build-query.mjs`, `run-queries.mjs`, etc.), and `query-index.json` records per-receipt inputs and requests. The markless repo (`/Users/jacksm5pro/dev/open-source/markless`) and the extracted versionless fixture (`docs/evidence/adoption-eval-fable-v1/raw-versionless/fixture/`) are the corpora — markless is READ-ONLY; first verify the serializer input files still match the v1 filesets (compare against the recorded inputs; if any input file drifted since v1, record the drift and re-audit that symbol's ground truth before scoring).

Procedure:
1. Re-run every v1 query (markless q00–q21, versionless q01–q25, same requests, same input sets) against the fixed engine via `node packages/cli/dist/cli.js query`. Write receipts to `docs/evidence/adoption-eval-fable-v2/raw-markless/` and `raw-versionless/` with the same names.
2. Score each query against the v1 ground truth: sites returned, sites named unresolved, sites missed-and-unnamed (must be ZERO — any instance leads the report and is a finding, not a footnote). Also record receipt-state transitions v1→v2 (e.g. complete→partial where unlinked inputs now surface).
3. Verify each defect class specifically: D1 — the q23 alias case now names `containers/HomePage/saga.js` (or returns its sites); D2 — q01-shaped referencesOf now include the import/re-export specifier sites (isValidStorageKey 6 identifier sites in src); D3 — q10 writesOf on `records` no longer returns bare complete/empty (the 10 push sites appear as method-call-mutation-uncertain unresolved or equivalent); D4 — q11 CJS exportedNames names the export constructs.
4. Sanity guard: confirm zero spurious sites (a result not in ground truth is a false positive — also a finding), and note receipt-size and timing changes v1→v2.
5. Write `docs/evidence/adoption-eval-fable-v2/report.md`: per-query score table, the four defect-class verdicts with receipt citations, the oracle line ("zero missed-and-unnamed: TRUE/FALSE"), and this era note verbatim: "Sealed pre-v2 evidence bundles (oracle-part-3-v1..v11, adoption-eval-fable-v1) remain byte-identical records of the pre-D2 reference contract, in which rename ground truth had 4 planted sites; the corrected contract derives 8. By PM ruling they are not retro-edited."

## File contract

- `docs/evidence/adoption-eval-fable-v2/**`

## Forbidden moves

- No writes outside the contract; v1 evidence, markless, engine sources, and dist are read-only. Why: the trial measures the shipped engine; evidence eras stay separate.
- Do not rebuild guessless. Why: HEAD dist is the artifact under test.
- Do not adjust v1 ground truth except where an input file provably drifted, and then only with the drift evidence recorded. Why: the oracle compares like with like.
- A missed-and-unnamed or spurious site is reported, never rationalized away. Why: the oracle is the point.

## Verification

```verify
node -e 'const fs=require("fs");const p="docs/evidence/adoption-eval-fable-v2";const t=fs.readFileSync(p+"/report.md","utf8");if(!/zero missed-and-unnamed: (TRUE|FALSE)/.test(t))throw new Error("missing oracle line");for(const d of ["raw-markless","raw-versionless"]){const files=fs.readdirSync(p+"/"+d).filter(f=>f.endsWith(".receipt.json"));if(files.length<15)throw new Error(d+" has "+files.length+" receipts");for(const f of files){const r=JSON.parse(fs.readFileSync(p+"/"+d+"/"+f,"utf8"));if(!["complete","partial","refused"].includes(r.state))throw new Error(f+" bad state")}}console.log("ok")'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. markless drifted so far the v1 ground truth is unusable), the CLI cannot answer, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.