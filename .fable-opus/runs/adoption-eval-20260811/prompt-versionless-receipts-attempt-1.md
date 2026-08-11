Fable-Opus-Unit: adoption-eval-20260811/versionless-receipts

## Goal

Produce a ground-truthed honesty trial of the guessless engine against real legacy code from the versionless repository's corpus — code that does not typecheck or has no installed dependencies, which is guessless's claimed sweet spot ("answers on code that does not build"). Working directory is the guessless workspace: /Users/jacksm5pro/dev/open-source/guessless. The versionless repository is at /Users/jacksm5pro/dev/open-source/versionless (READ ONLY — never write there). Its `fixtures/` directory holds pinned legacy fixtures (e.g. React Boilerplate v4 era code); if fixtures are stored as archives, you may extract a copy INTO your contract directory to read from, never in place.

Guessless CLI usage (already built, do not rebuild):
- `node packages/cli/dist/cli.js query <file.json>` or `query -` for stdin.
- Document shape: `{"inputs":[{"path":"<relative path>","source":"<contents>"}...],"request":{...}}`.
- The engine analyzes ONLY supplied inputs; ground truth must be computed over exactly the same file set, and the report must state the input set per query.
- Request shapes: `{"kind":"resolveBinding","file":"...","name":"...","space":"value","scope":null}` → returns a symbol anchor. `{"kind":"referencesOf","target":<anchor>}` (same for readsOf/writesOf/reachableFrom/reaches/definitionOf/capturesOf). `{"kind":"exportedNames","file":"..."}`.
- Receipt states: `complete` | `partial` (with `unresolved` + closed reasons) | `refused`.

Context from the prior markless unit (already sealed — replicate, don't re-litigate): two missed-and-unnamed defect classes were found there: (a) `writesOf` detects only assignments, so mutation via method calls like `.push()` returns `complete` with zero results; (b) `referencesOf` silently omits import specifiers and cross-module re-export specifiers under `complete`.

Procedure:
1. Pick one coherent legacy JS/JSX subsystem from the versionless corpus, roughly 10–40 files, that provably does not build (note why: no node_modules, fails typecheck, legacy syntax, etc.).
2. Choose 3 symbols with cross-file usage in that set (legacy React patterns preferred: a connected component, an action creator or selector used across files, something imported under an alias if available). Establish exhaustive ground truth per symbol over the input set by search and reading; record exact commands and site lists.
3. Run resolveBinding + referencesOf for all 3; reachableFrom or reaches for one entry point; exportedNames for one module. Record states, sites vs ground truth, misses that are unnamed (critical — leads the report if found), spurious sites, per-query wall time and receipt bytes.
4. Replication probes: one `writesOf` on a binding mutated via method call in this legacy code (does defect (a) reproduce?), and one `referencesOf` on a symbol that appears in import/re-export specifiers (does defect (b) reproduce?).
5. Sweet-spot check: explicitly state in the report whether the engine produced useful receipted answers despite the code being unbuildable, and what an LSP/typechecker-based tool would have needed (deps installed, tsconfig, etc.). Do not run an LSP tool; just state the requirements factually.

Deliverables, all under `docs/evidence/adoption-eval-fable-v1/`:
- `versionless-report.md` — scored report with ground-truth tables, evidence commands, replication verdicts, and a short verdict paragraph on the honesty contract for this corpus.
- `raw-versionless/*.receipt.json` — every receipt verbatim (at least 5 receipt files), plus any helper scripts and extracted fixture copies under `raw-versionless/`.

## File contract

- `docs/evidence/adoption-eval-fable-v1/versionless-report.md`
- `docs/evidence/adoption-eval-fable-v1/raw-versionless/**`

## Forbidden moves

- No writes outside the contract; never write in the versionless repo or guessless sources/dist. Why: evidence trial; products under test must not change.
- Do not rebuild guessless. Why: trial runs against the current built artifact.
- Your manual audit is ground truth only; never substitute it for the engine's answer when scoring. Why: the trial measures the engine.
- Do not soften a missed-and-unnamed site; if found, it leads the report. Why: that is the defect class the product claims to make impossible.

## Verification

```verify
node -e 'const fs=require("fs");const p="docs/evidence/adoption-eval-fable-v1";const rep=p+"/versionless-report.md";if(!fs.existsSync(rep))throw new Error("missing report");const dir=p+"/raw-versionless";const files=fs.readdirSync(dir).filter(f=>f.endsWith(".receipt.json"));if(files.length<5)throw new Error("need >=5 receipts, got "+files.length);for(const f of files){const r=JSON.parse(fs.readFileSync(dir+"/"+f,"utf8"));if(!["complete","partial","refused"].includes(r.state))throw new Error(f+" bad state: "+r.state)}console.log("ok:",files.length,"receipts")'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. no usable legacy fixture exists), the CLI cannot answer any query, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.