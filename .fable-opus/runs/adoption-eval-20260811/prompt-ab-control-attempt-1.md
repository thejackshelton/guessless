Fable-Opus-Unit: adoption-eval-20260811/ab-control

## Goal

Answer two structural questions about the markless serializer package at /Users/jacksm5pro/dev/open-source/markless/packages/serializer (READ ONLY — never write there). This is analysis only: do not edit any file anywhere except your single answer file. Write your answer to `docs/evidence/adoption-eval-fable-v1/ab/control-answer.md` in the guessless workspace (your working directory).

Question 1 — Rename plan. We intend to rename the function `isValidStorageKey` to `isAllowedStorageKey` across the serializer package (src and test). Produce the complete list of every site that must change or must be reviewed for this rename, as `file:line — what it is`. Then state explicitly on its own line either `CLAIM: COMPLETE` (you assert this is every site) or `CLAIM: NOT COMPLETE` with what remains uncertain.

Question 2 — Mutation. Does the function `encodeSlot` in `src/value.ts` mutate its `records` parameter? Answer yes/no, list every mutation site as `file:line`, and state `CLAIM: COMPLETE` or `CLAIM: NOT COMPLETE` for your mutation-site list.

Structure the answer file with `## Question 1` and `## Question 2` headers, the site lists, the CLAIM lines, and a short note on how you established each answer.

## File contract

- `docs/evidence/adoption-eval-fable-v1/ab/control-answer.md`

## Forbidden moves

- Do not read anything under `docs/` of the guessless workspace. Why: out of scope for this task.
- Do not write anywhere except the contract file; never modify the markless repository. Why: analysis-only task.
- Do not hedge the CLAIM lines: pick COMPLETE or NOT COMPLETE. Why: the deliverable is a committed answer.

## Verification

```verify
node -e 'const fs=require("fs");const f="docs/evidence/adoption-eval-fable-v1/ab/control-answer.md";const t=fs.readFileSync(f,"utf8");if(!/## Question 1/.test(t)||!/## Question 2/.test(t))throw new Error("missing sections");if(!/CLAIM: (NOT )?COMPLETE/.test(t))throw new Error("missing CLAIM line");console.log("ok",t.length,"bytes")'
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.