Fable-Opus-Unit: must-have-fixes-20260811/d2-d3-reference-completeness
Fable-Opus-Timeout-Minutes: 45
Fable-Opus-Effort: high
Effort-Justification: Two coupled honesty defects in the reference query layer with closed-enumeration contract decisions; a wrong access-classification choice would trade one dishonesty for another.

## Goal

Fix defect classes D2 and D3 in the guessless engine as one reference-completeness slice. Evidence and definitions live in `docs/evidence/adoption-eval-fable-v1/verdict.md`, with raw receipts in `raw-markless/` and `raw-versionless/`.

**D2 — specifier sites omitted.** `referencesOf`/`readsOf`/`writesOf` return use sites but silently omit import specifiers (`import { x } from ...`) and cross-module re-export specifiers (`export { x } from ...`) under `complete`, while *local* export specifiers (`export { x }` without a from-clause) ARE returned — an undocumented asymmetry. Evidence: `raw-markless/q01-refs-isvalidstoragekey.receipt.json` returned 2 sites while the rename ground truth includes import specifiers and a re-export specifier; the versionless trial missed all 16 ground-truth import specifiers. Required behavior: reference queries include specifier sites for the queried symbol — import specifiers, re-export specifiers, and local export specifiers, consistently — each as a normal `{access, site}` result (specifier occurrences are `read` access unless genuinely otherwise). A consumer must be able to enumerate every site a rename must touch (string/comment occurrences excepted — those are outside structural analysis by design and stay out).

**D3 — method-call mutation invisible to `writesOf`.** Write classification is assignment-only: a parameter mutated by ten `records.push(...)` calls yields `writesOf` = `complete` with zero results (`raw-markless/q10-writes-records.receipt.json`), while the README promises "references that write **or may mutate** a symbol". Required behavior, fail-closed and honest in both directions: a member call on a tracked binding (`x.push(...)`, `x.sort()`, `Object.assign(x, ...)` where `x` is the queried binding, etc.) must never leave `writesOf` returning a bare `complete` with the mutation invisible. Choose ONE of these designs and implement it consistently:
  (a) classify member-call receivers with a maintained list of known-mutating methods as `read-write` access, AND name every *other* member call on the binding as an unresolved site (uncertain mutation), or
  (b) name ALL member calls on the queried binding as unresolved sites with a closed reason (no mutation claims at all).
  Do not claim `write` for calls you cannot prove mutate (that would trade false-complete for false-positive — `.map()` must never be reported as a write). For the unresolved reason: reuse an existing `UNRESOLVED_REASONS` member ONLY if its documented meaning genuinely covers method-call-may-mutate (inspect `property-alias-write-uncertain`); otherwise add one new named reason (e.g. `method-call-mutation-uncertain`). Update the `writesOf` row in the root `README.md` query table to state exactly what is and is not claimed.

Note the engine already has `packages/engine/src/linking.ts` from the D1 fix (merged); the closed enum currently has 17 members ending in `unlinked-input`. Follow the same code conventions.

Regression tests in `packages/engine/test/` covering the class, not the fixture:
1. Markless-shaped rename fixture: a function exported from one file, re-exported via `export { x } from './...'` in a barrel, imported in two consumers, called in each — assert `referencesOf` returns all specifier sites plus call sites (7-site shape) under `complete`.
2. Aliased import specifier (`import { x as y }`) — both the specifier site and aliased uses attributed to the origin symbol.
3. `export *` chain — sites through the star re-export; if star re-exports cannot carry a specifier site, the boundary must be named unresolved, not silent.
4. Mutation fixture: parameter with 10+ `.push()` calls — `writesOf` must surface every mutation site per your chosen design (as read-write results or named unresolved), never `complete` and empty.
5. Negative controls: `.map()`/`.includes()` on the binding never reported as `write`; plain assignments still classified exactly as today; a fixture with no specifiers/mutations produces byte-identical results to the current engine.

Existing tests must stay green (218 pass / 8 skipped in the default gate); update pinned hashes only where the receipt content change is the intended one, stating intent in the test.

You are in a fresh git worktree without node_modules. Your FIRST command must be `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/engine/src/**`
- `packages/engine/test/**`
- `packages/*/dist/**`
- `README.md`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch `packages/mcp`, `packages/cli`, `packages/oracle`, `packages/evaluation` sources or tests. Why: adapters inherit the engine; the evidence suites are sealed and opt-in.
- Do not modify anything under `docs/`. Why: sealed evidence and the goal board are immutable to this slice.
- Do not delete or weaken existing tests; hash-pin updates must preserve assertion intent. Why: the suite is the honesty corpus.
- Do not remove or rename any existing `UNRESOLVED_REASONS` member or change the `access` value set (`read`/`write`/`read-write`). Why: closed contract, extended by ruling only.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. yuku-analyzer does not expose specifier references at all and the fix needs an analyzer change), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.