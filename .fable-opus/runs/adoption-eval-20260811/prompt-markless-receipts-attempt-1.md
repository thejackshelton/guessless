Fable-Opus-Unit: adoption-eval-20260811/markless-receipts

## Goal

Produce a ground-truthed honesty trial of the guessless engine against real code from the markless repository, and record how guessless behaves at the `.tsrx` boundary. Working directory is the guessless workspace: /Users/jacksm5pro/dev/open-source/guessless. The markless repository is at /Users/jacksm5pro/dev/open-source/markless (READ ONLY — never write there).

Guessless CLI usage (already built, do not rebuild):
- `node packages/cli/dist/cli.js query <file.json>` or `query -` for stdin.
- The JSON document is `{"inputs":[{"path":"<relative path>","source":"<file contents>"}...],"request":{...}}`.
- The engine analyzes ONLY the supplied inputs. A reference in a file you did not supply is invisible by design. Therefore ground truth for each query must be computed over exactly the same file set you supply as inputs. State the input set explicitly in the report for every query.
- Request shapes: `{"kind":"resolveBinding","file":"...","name":"...","space":"value","scope":null}` returns a symbol anchor. `{"kind":"referencesOf","target":<that anchor object>}` (same for readsOf/writesOf/reachableFrom/reaches/definitionOf/capturesOf). `{"kind":"exportedNames","file":"..."}`.
- Every receipt has `state`: `complete` | `partial` (with `unresolved` sites + closed reasons) | `refused` (with reason).

Procedure:
1. Pick one coherent markless package or subsystem written in `.ts` (not `.tsrx`), roughly 10–60 files. Choose 3 exported symbols with cross-file usage inside that set; at least one must be structurally tricky (re-exported, imported under an alias, or shadowed somewhere).
2. For each symbol, establish exhaustive ground truth over the chosen input set by search and reading: every file and identifier occurrence that references the symbol (distinguish true references from same-name coincidences). Record the exact commands used and the site list in the report. Do not fabricate; if you cannot be exhaustive for a symbol, say so and pick a different symbol.
3. Build the query documents with a small helper script (a Node script that reads the file list and emits the JSON is fine — keep the script inside the evidence directory). Run: resolveBinding then referencesOf for all 3 symbols; writesOf for at least one symbol that is mutated somewhere if such exists (otherwise note that); exportedNames for one module.
4. Boundary probe: run one query whose inputs include a real `.tsrx` file from markless, and one query on a `.ts` file that imports from a `.tsrx` module which is NOT parseable — record exactly what the receipt says (refused? partial with `unparsed-file`? something else?).
5. Score each query in the report: receipt state; sites found vs ground truth; any site that is BOTH missed and not named in `unresolved` (this is the critical failure class — flag prominently if it occurs); spurious sites; whether partial's unresolved reasons genuinely account for gaps. Also record wall time per query and receipt byte size.

Deliverables, all under `docs/evidence/adoption-eval-fable-v1/`:
- `markless-report.md` — the scored report, including the ground-truth site tables with evidence commands, and a short verdict paragraph: does the honesty contract hold on this real code, yes/no/with caveats.
- `raw-markless/*.receipt.json` — every receipt verbatim, one file per query (at least 4 receipt files).
- Any helper scripts you wrote, under `raw-markless/`.

## File contract

- `docs/evidence/adoption-eval-fable-v1/**`

## Forbidden moves

- Do not write anywhere outside the contract, especially not in the markless repository or guessless package sources. Why: this is an evidence-producing trial; the products under test must not change.
- Do not rebuild guessless (`pnpm build` etc.) or modify dist. Why: the trial must run against the current built artifact.
- Do not substitute your own analysis (grep-based reference finding) for the engine's answer when scoring — your manual audit is the ground truth side only. Why: the trial measures the engine.
- Do not soften a missed-and-unnamed site. If one occurs, it leads the report. Why: that is the exact defect class this product claims to make impossible.

## Verification

```verify
node -e 'const fs=require("fs");const p="docs/evidence/adoption-eval-fable-v1";const rep=p+"/markless-report.md";if(!fs.existsSync(rep))throw new Error("missing report");const dir=p+"/raw-markless";const files=fs.readdirSync(dir).filter(f=>f.endsWith(".receipt.json"));if(files.length<4)throw new Error("need >=4 receipts, got "+files.length);for(const f of files){const r=JSON.parse(fs.readFileSync(dir+"/"+f,"utf8"));if(!["complete","partial","refused"].includes(r.state))throw new Error(f+" bad state: "+r.state)}console.log("ok:",files.length,"receipts")'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, the CLI cannot be made to answer any query at all, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.