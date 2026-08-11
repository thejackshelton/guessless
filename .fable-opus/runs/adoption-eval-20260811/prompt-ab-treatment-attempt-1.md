Fable-Opus-Unit: adoption-eval-20260811/ab-treatment

## Goal

Answer two structural questions about the markless serializer package at /Users/jacksm5pro/dev/open-source/markless/packages/serializer (READ ONLY — never write there). This is analysis only: do not edit any file anywhere except inside your contract. Write your answer to `docs/evidence/adoption-eval-fable-v1/ab/treatment-answer.md` in the guessless workspace (your working directory).

You have the guessless structural-analysis engine available and MUST use it to ground your answers before finalizing them. Usage:
- `node packages/cli/dist/cli.js query <file.json>` (or `query -` for stdin), run from the guessless workspace root.
- Document shape: `{"inputs":[{"path":"<relative path>","source":"<file contents>"}...],"request":{...}}`. The engine analyzes ONLY the supplied inputs; include every serializer file you want covered (a small helper script may build the JSON — keep it under `ab/treatment-scratch/`).
- Request shapes: `{"kind":"resolveBinding","file":"...","name":"...","space":"value","scope":null}` → returns a symbol anchor; then `{"kind":"referencesOf","target":<anchor>}` (likewise readsOf / writesOf / definitionOf / reachableFrom / reaches / capturesOf); `{"kind":"exportedNames","file":"..."}`.
- Every receipt carries a state: `complete` | `partial` (with named `unresolved` sites) | `refused`. Cite the receipt state you relied on for each answer.
- Run at least one relevant guessless query per question. You may also use ordinary tools; if the receipt and other evidence disagree, investigate and say which you trusted and why.

Question 1 — Rename plan. We intend to rename the function `isValidStorageKey` to `isAllowedStorageKey` across the serializer package (src and test). Produce the complete list of every site that must change or must be reviewed for this rename, as `file:line — what it is`. Then state explicitly on its own line either `CLAIM: COMPLETE` (you assert this is every site) or `CLAIM: NOT COMPLETE` with what remains uncertain.

Question 2 — Mutation. Does the function `encodeSlot` in `src/value.ts` mutate its `records` parameter? Answer yes/no, list every mutation site as `file:line`, and state `CLAIM: COMPLETE` or `CLAIM: NOT COMPLETE` for your mutation-site list.

Structure the answer file with `## Question 1` and `## Question 2` headers, the site lists, the CLAIM lines, the guessless receipt states you used, and a short note on how you established each answer.

## File contract

- `docs/evidence/adoption-eval-fable-v1/ab/treatment-answer.md`
- `docs/evidence/adoption-eval-fable-v1/ab/treatment-scratch/**`

## Forbidden moves

- Do not read anything under `docs/` of the guessless workspace except your own contract paths. Why: out of scope for this task.
- Do not write anywhere except the contract; never modify the markless repository or guessless sources/dist. Why: analysis-only task.
- Do not hedge the CLAIM lines: pick COMPLETE or NOT COMPLETE. Why: the deliverable is a committed answer.

## Verification

```verify
node -e 'const fs=require("fs");const f="docs/evidence/adoption-eval-fable-v1/ab/treatment-answer.md";const t=fs.readFileSync(f,"utf8");if(!/## Question 1/.test(t)||!/## Question 2/.test(t))throw new Error("missing sections");if(!/CLAIM: (NOT )?COMPLETE/.test(t))throw new Error("missing CLAIM line");if(!/complete|partial|refused/.test(t))throw new Error("no receipt state cited");console.log("ok",t.length,"bytes")'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, the CLI cannot be made to answer, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.