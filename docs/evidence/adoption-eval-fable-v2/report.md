# adoption-eval-fable-v2 — honesty retrial against the fixed engine

**Unit:** `must-have-fixes-20260811/v2-honesty-retrial`
**Date:** 2026-08-11
**Predecessor:** `docs/evidence/adoption-eval-fable-v1/` (read-only input; not retro-edited)

## Oracle

```
zero missed-and-unnamed: FALSE
```

51 queries re-run (markless q00–q21, versionless q01–q25). Scored against the hand-audited v1
ground truth by `score.mjs`, whose output is checked in as `scores.json`:

| | v1 (recomputed under the same rule) | v2 |
| --- | --- | --- |
| ground-truth sites returned in `results` | 140 | **166** |
| ground-truth sites named in `unresolved` | 11 | **29** |
| **missed and unnamed** | **51** | **7** |
| spurious (result with no ground-truth counterpart) | 0 | **0** |

The oracle is **FALSE** on a single residual class, described immediately below. All four
commissioned defect classes (D1–D4) are fixed, and 44 of the 51 v1 missed-and-unnamed sites are
now either returned or named. Nothing else regressed: no ground-truth site that v1 returned is
absent from v2, and no spurious site appeared anywhere.

---

## 1. The finding: `writesOf` still drops 7 by-reference escape sites, unnamed

**Receipt:** `raw-markless/q10-writes-records.receipt.json` — `state: "partial"`, `results: []`,
`unresolved` = 10 entries, all `method-call-mutation-uncertain`.

The v1 ground truth for `writesOf` on the `records` parameter of `encodeSlot`
(`packages/serializer/src/value.ts`, lines 146–338) is **17 mutation-bearing sites**, in two
groups (v1 `markless-report.md` §1 D1, verbatim: *"All 17 mutation-bearing sites are missing and
none is named"*):

| group | lines | v1 | v2 |
| --- | --- | --- | --- |
| `records.push(…)` mutations (10) | 176, 185, 194, 204, 219, 235, 257, 274, 308, 328 | missed, unnamed | **named** — 10 × `method-call-mutation-uncertain` |
| by-reference escapes into a mutating callee (7) | 223, 238, 261, 281, 288, 311, 331 | missed, unnamed | **missed, unnamed** |

The 7 escapes are argument positions where `records` is handed to `encodeSlot` or
`encodeArrayBufferViewBuffer`, each of which pushes into it — e.g. value.ts:223

```ts
buffer: encodeArrayBufferViewBuffer(value, path, seen, records, diagnostics),
```

`referencesOf` on the same anchor (`raw-markless/q08-refs-records.receipt.json`) returns all
seven of these sites, so the engine sees them; it classifies them `read`, and `writesOf` neither
returns them nor spends an `unresolved` entry on them. The receipt's ten `unresolved` entries are
each anchored at a `site:method-call-receiver` path — they account for the ten `.push` statements
and for nothing else, so file-level attribution cannot be stretched to cover the escapes.

This is materially narrower than the v1 defect and the receipt no longer lies about it — the
state is `partial`, not `complete` — but a caller asking "is anything mutating `records`?" still
gets a receipt whose named boundaries under-describe the answer by seven sites. It is the same
root shape as v1's D1: mutation reachable *through* a reference is not modelled, and where the
new code could not prove a mutation it emitted a reason, while where it could not even see the
question it emitted nothing.

The analogous versionless case does **not** reproduce: `plugins` at
`internals/scripts/extract-intl.js:97` is passed into `transform(…)` by object-property shorthand,
and v1's ground truth for `q15` counted it as a read only (2 write sites, not 3), so v2's
`q15-writesOf-plugins` scores 0 missed-and-unnamed.

**No spurious sites.** Across all 51 receipts, every `results` entry maps to a ground-truth site
(`scores.json` `totals.spurious = 0`). The engine gained recall without inventing anything.

---

## 2. Method

### 2.1 Engine under test — not rebuilt

| artifact | sha256 | vs v1 |
| --- | --- | --- |
| `packages/cli/dist/cli.js` | `784899828ad9c45b0a5d3532ab29cea674832153fa2be187c74fd1e51f775439` | identical |
| `packages/cli/dist/src-DWRHl3Qf.js` | `4a406b37aa6b3eb65c10d64a98f31011bf4adf30337343a0aade58fc931a7e85` | identical |
| `packages/engine/dist/index.js` | `1605ea0329fc065cf55d5f5b68191f6e7111459fe1d0d05e20dc3b0b06642bd5` | **changed** |

The CLI bundle is byte-identical to the one v1 ran; it does `await import("@guessless/engine")`,
which resolves through `packages/cli/node_modules/@guessless/engine → ../../../engine`. All of
D1–D4 therefore lives in `packages/engine/dist/index.js`. Repository HEAD `3da8ce4`; every `dist/`
file dated 2026-08-11 18:22. Nothing was built during this unit. Node v24.15.0, darwin 25.5.0.

### 2.2 Corpora — verified identical to v1

**markless** `/Users/jacksm5pro/dev/open-source/markless` @ `931f054444a41c0527dfa77f812fa49e87df3b8f`
— the same commit v1 cited. `git status --porcelain -- packages/serializer/src demos/live-feed/src`
and `git ls-files --others --exclude-standard` on the same paths are both empty, so every input
byte is the committed byte. Read-only throughout.

**versionless** the fixture already extracted into the v1 bundle,
`raw-versionless/fixture/react-boilerplate-d19099afeff64ecfb09133c06c1cb18c0d40887e/`
(react-boilerplate @ `d19099af…`), read in place.

**Mechanical drift proof.** The engine hashes its input set into `receipt.snapshot`. Across all
51 v2 receipts the snapshot equals the v1 snapshot for the same query — `snapshotMatchesV1: true`
in both `raw-markless/timings.json` and `raw-versionless/timings.json`, 51/51. Zero input drift;
no ground truth needed re-auditing.

### 2.3 Queries — same inputs, same requests

* `raw-markless/run-markless-v2.mjs` rebuilds each of the 26 markless documents from the ordered
  input path list and the **verbatim request** recorded per receipt in v1's
  `raw-markless/query-index.json`, including the v1 `target` anchors with their v1 fingerprints.
  The three `probe/` documents (q19–q21) are reconstructed by the same rules as v1's
  `make-unparsed-probe.mjs` / `make-unparsed-dependent-probe.mjs`. Query documents are 2.2 MB of
  duplicated source and, as in v1, are not checked in; `query-index.json` here re-records inputs,
  request, snapshot and state per receipt.
* `raw-versionless/run-queries-v2.mjs` is v1's `run-queries.mjs` with only the fixture path and
  the output directory changed. It keeps v1's rule that every `target` is lifted from the
  engine's own `resolveBinding` result — no hand-authored anchors.

**Anchor stability.** Every re-derived anchor is byte-identical to v1's (19/19 checked across both
corpora: all `resolveBinding` receipts plus `definitionOf`). The v1 requests remained valid
verbatim, so this is a like-for-like comparison rather than a re-targeted one.

### 2.4 Scoring

`score.mjs` transcribes the v1 reports' ground-truth tables and scores each receipt:

* **returned** — a result matches the site on (file, site class), where class is
  `import` (`site:import-specifier`), `reexport` (`site:reexport-specifier`) or `use`
  (everything else, including local `export { X }` specifiers and type-position uses);
* **named** — not returned, but an `unresolved` entry accounts for it. Every one of the 29 named
  sites in v2 is covered by a causally specific entry, not merely a same-file one:
  `unlinked-input` naming the exact import the symbol arrives through (24),
  `unrecognized-export-form` quoting the exact `exports.X = …` statement (4), and
  `method-call-mutation-uncertain` anchored at the mutating call (10 in q10, 1 in q15 — counted
  one per site);
* **missed and unnamed** — neither;
* **spurious** — a result with no ground-truth counterpart.

Run `GL_BUNDLE=../adoption-eval-fable-v1 GL_SCORES=scores-v1-recomputed.json node score.mjs` to
score the v1 bundle with the identical rule; that file is checked in, and it is the source of the
v1 column in every table here. Its total (51 missed-and-unnamed) is the same measurement applied
to v1's receipts.

That recomputed baseline is deliberately **more forgiving to v1** than the v1 reports were. Where
a missed site sat in a file that happened to carry unrelated `unresolved` entries, `score.mjs`
credits it as named, while the v1 reports read the reasons and refused the credit (their prose
totals come to 59). The one place that leniency would have mattered to a defect verdict —
versionless `q11`'s CommonJS exports, where the only entries were `require()` boundaries — is
excluded explicitly in the code. So the v1 baseline here understates v1's problem, which is the
conservative direction: it cannot flatter v2.

---

## 3. Defect-class verdicts

### D1 — alias-imported bystander files are now named (`unlinked-input`) — **PASS**

**Receipt:** `raw-versionless/q23-references-reposLoaded.receipt.json` (SET-A, verbatim fixture,
webpack-alias specifiers). v1: `containers/HomePage/saga.js` appeared *nowhere* in the receipt.
v2: the file is named four times with a new closed reason —

```json
{ "reason": "unlinked-input",
  "detail": "Import 'containers/App/actions' did not resolve, but names a supplied input; the link between these files could not be established." }
```

— naming the exact specifier through which `reposLoaded` reaches saga.js, plus the same for
`containers/HomePage/tests/saga.test.js`. Both of that file's ground-truth sites (saga.js:7
import specifier, saga.js:23 use) are therefore accounted for. `q23` scores 4 returned + 4 named
+ **0 missed-and-unnamed**, against v1's 2 returned + 1 named + 5 missed-and-unnamed.

The A/B control still holds and is now uninformative in the right way: `q25` (SET-E, the two
specifier strings relativised) returns **8/8** sites. The gap between "resolves" and "does not
resolve" is now the gap between `results` and a named `unresolved` entry, not between visible and
invisible.

Same fix visible in `q04` (saga.js sites named), `q06` and `q20` (saga.js + saga.test.js named,
both rootings), and in `q12-exportednames-homepage-saga`, where saga.js's own alias imports are
now `unlinked-input` rather than `external-module-boundary` — a more accurate reason, since the
target really is a supplied input.

### D2 — reference queries now return import and re-export specifier sites — **PASS**

**Receipt:** `raw-markless/q01-refs-isvalidstoragekey.receipt.json` — `state: "complete"`,
**5 results** (v1: 2), which is every non-declaration occurrence of the symbol in the input set,
i.e. all 6 identifier sites in `packages/serializer/src` minus the declaration that
`definitionOf` owns:

| ground-truth site | v1 | v2 |
| --- | --- | --- |
| `storage-slot.ts:1` re-export specifier w/ source | missed, unnamed | `site:reexport-specifier` |
| `protocol-validation-storage.ts:8` import specifier | missed, unnamed | `site:import-specifier` |
| `protocol-validation-storage.ts:45` call | returned | returned |
| `storage-record-client.ts:3` import specifier | missed, unnamed | `site:import-specifier` |
| `storage-record-client.ts:17` call | returned | returned |

The engine now emits distinct site-class heads (`site:import-specifier`, `site:reexport-specifier`)
rather than folding them into `site:reference`, so a consumer can tell an edit site's kind without
re-parsing. The v1 internal inconsistency is gone: `export { X }` and `export { X } from './y'`
are both returned, in `q03` and `q01` respectively.

All 7 markless D2 sites are recovered (`q01` 3, `q02` 2, `q03` 2 → all 0 missed-and-unnamed), and
so are the versionless import specifiers: `q02` **8/8** and `q25` **8/8** — full recall, including
sites inside the two JSX-broken files whose parse diagnostics v1 had to lean on. `q21` on the
markless unparseable-caller probe went 1 → 2 results, recovering the import specifier inside a file
the engine cannot fully parse.

### D3 — `writesOf` on a method-call-mutated binding no longer returns bare complete/empty — **PASS (with the §1 residual)**

**Receipt:** `raw-markless/q10-writes-records.receipt.json`. v1 was
`{"state":"complete","results":[],"unresolved":absent}`. v2 is `state: "partial"` with ten

```json
{ "reason": "method-call-mutation-uncertain",
  "detail": "Call on a member of 'records' may mutate it; structural evidence cannot prove whether it does." }
```

one per `records.push(…)` site, each anchored at `site:method-call-receiver`. The packet's D3
criterion — the 10 push sites appear as `method-call-mutation-uncertain` unresolved — is met
exactly. The 7 by-reference escapes remain unaccounted; see §1.

Replicates on versionless: `raw-versionless/q15-writesOf-plugins.receipt.json` gains a
`method-call-mutation-uncertain` entry for `plugins.push('react-intl')` at line 23, the exact site
v1 scored as missed-and-unnamed. The control `q18-writesOf-progress` is unchanged (1 result, the
real assignment), so precision on genuine reassignment was not traded away.

### D4 — CommonJS `exportedNames` now names the export constructs — **PASS**

**Receipt:** `raw-versionless/q11-exportednames-i18n-cjs.receipt.json` — still `results: []`
(guessless does not claim ES export names for CJS), but `unresolved` grew 5 → 9, and the four new
entries name the four constructs one-for-one:

```json
{ "reason": "unrecognized-export-form",
  "detail": "CommonJS export assignment 'exports.appLocales = appLocales' lies outside the ES module system; guessless does not analyze it, so no exported name is claimed for it." }
```

plus `formatTranslationMessages`, `translationMessages`, `DEFAULT_LOCALE`. A reader can no longer
mistake the empty result for "this module exports nothing". ESM `exportedNames` is untouched:
`q10` 6/6, `q12` 2/2, markless `q05` 8/8.

---

## 4. Sanity guards

### 4.1 Spurious sites: zero

`scores.json` → `totals.spurious = 0` over all 51 queries, matching v1. Every new result is a
ground-truth site. Near-miss neighbours the v1 audit called out are still correctly excluded —
`ASYNC_BOUNDARY_ARM_MIN/_PENDING/_MAX` do not appear in `q03`, the other three `records` bindings
do not leak into `q08`, and the Set-branch `let index` does not leak into `q12`.

### 4.2 New over-naming (precision cost, not a miss)

The mutation-uncertainty reason fires on some call shapes that cannot mutate the target:

* `raw-markless/q03-refs-asyncboundaryarm.receipt.json` and `q04b-writes-asyncboundaryarm` each
  carry one `method-call-mutation-uncertain` entry for `protocol-validation.ts:301`,
  `Object.values(ASYNC_BOUNDARY_ARM).includes(value as never)` — here `ASYNC_BOUNDARY_ARM` is an
  *argument*, and the method call is on the array `Object.values` returned. `q04b` consequently
  reports `partial` on a binding that genuinely has no writes.
* `raw-versionless/q15-writesOf-plugins` carries a second entry for
  `plugins = plugins.filter(…)` at line 26 — `filter` does not mutate.

This is the honest direction to err (an over-named boundary costs a reader a check; an unnamed one
costs them a wrong answer), and it never manufactures a `results` entry. It is worth a follow-up:
restricting the reason to calls whose *receiver* is the target binding would remove all three
false alarms without touching any of the 11 true ones.

### 4.3 Receipt-state transitions v1 → v2

Five markless receipts moved `complete` → `partial`; no receipt moved in the other direction, and
no `refused` changed.

| receipt | v1 | v2 | cause |
| --- | --- | --- | --- |
| `q03-refs-asyncboundaryarm` | complete | partial | 1 over-named mutation-uncertainty (§4.2) |
| `q04b-writes-asyncboundaryarm` | complete | partial | same |
| `q08-refs-records` | complete | partial | 10 mutation-uncertainty entries |
| `q09-reads-records` | complete | partial | same |
| `q10-writes-records` | complete | partial | same — the D3 fix |

Versionless had no state transitions: every receipt that was `partial` stayed `partial` and every
`complete` stayed `complete`. The `unlinked-input` reason replaced or supplemented entries in
receipts that were already `partial`, which is why D1's fix is visible in the reason text rather
than in the state.

Note the shape of this: on markless, the fixes *cost* four `complete` badges on queries that were
already correct, and bought one on a query that was wrong. That is the trade the honesty contract
asks for, but it does mean `complete` is now rarer on real code, and §4.2's over-naming is what
makes it rarer than it needs to be.

### 4.4 Size and timing

| corpus | receipts | total bytes v1 → v2 | wall min / median / max (v2) |
| --- | --- | --- | --- |
| markless | 26 | 51,034 → 70,009 (**+37 %**) | 26.8 / 46.8 / 257.3 ms |
| versionless | 25 | 193,469 → 261,083 (**+35 %**) | 35.1 / 42.4 / 95.4 ms |

Growth is concentrated where the fixes fire: `q10-writes-records` 670 B → 5,833 B (an empty
receipt became ten named sites), `q08`/`q09` +5.2 KB each, and the versionless `referencesOf`
receipts +8 KB each (~30 KB, from ~21 KB) as bystander files acquire `unlinked-input` entries.
`q09-reaches-getRepos` more than doubled (7,881 → 16,271 B) with no change in results — the whole
increase is newly named boundaries. Wall times are single-run here versus v1's 3-run medians, so
they are not directly comparable; nothing in either corpus exceeds ~260 ms, and the ranking of
slow queries (the `records` family on markless, `writesOf`/`readsOf` on versionless) is unchanged.

The v1 observation that receipt size is driven by anchors, not data, still holds and is now
sharper: a `referencesOf` receipt on 35 files carries ~30 KB, of which the `unresolved` list is
still the bulk. The honesty gain is real and so is its context cost.

### 4.5 What did not change

`resolveBinding` is bit-stable: 19/19 anchors identical to v1, including the scoped and
block-scoped ones, the nested-scope refusal (`q21-resolve-actions-array-nested`, still 0 results /
`partial`), and the `.tsrx` boundary suite (`q14`–`q16` still refuse the whole batch with
`unsupported-language`; `q17`–`q19` still `partial` with the boundary named). `reachableFrom`
(11/11) and `readsOf` (24/24, 3/3) are unchanged on results.

---

## 5. Per-query score table

`v1→v2` in every cell. `GT` is the v1 ground-truth site count for that query. `missed` is
missed-and-unnamed — the oracle column.

### 5.1 markless (Set A = 20 `@markless/serializer` files unless noted)

| query | state | GT | returned | named | missed | spurious | bytes | wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `q00-resolve-isvalidstoragekey` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 680→680 | 39.5 |
| `q00-resolve-serializegraphvalue` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 672→672 | 36.5 |
| `q00-resolve-asyncboundaryarm` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 695→695 | 46.8 |
| `q01-refs-isvalidstoragekey` | complete→complete | 5 | 2→5 | 0→0 | 3→**0** | 0 | 1473→2401 | 41.2 |
| `q02-refs-serializegraphvalue` | complete→complete | 6 | 4→6 | 0→0 | 2→**0** | 0 | 2290→2897 | 191.2 |
| `q03-refs-asyncboundaryarm` | complete→partial | 6 | 4→6 | 0→0 | 2→**0** | 0 | 2029→3166 | 63.9 |
| `q04-writes-serializegraphvalue` | complete→complete | 0 | 0→0 | 0→0 | 0→**0** | 0 | 570→570 | 181.4 |
| `q04b-writes-asyncboundaryarm` | complete→partial | 0 | 0→0 | 0→0 | 0→**0** | 0 | 581→1117 | 67.2 |
| `q05-exportednames-storage-slot` | complete→complete | 8 | 8→8 | 0→0 | 0→**0** | 0 | 2447→2447 | 39.6 |
| `q06-resolve-encodeslot` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 654→654 | 39.8 |
| `q06b-refs-encodeslot` | complete→complete | 7 | 7→7 | 0→0 | 0→**0** | 0 | 3452→3452 | 179.8 |
| `q07-resolve-records` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1123→1123 | 172.4 |
| `q08-refs-records` | complete→partial | 24 | 24→24 | 0→0 | 0→**0** | 0 | 10217→15380 | 229.9 |
| `q09-reads-records` | complete→partial | 24 | 24→24 | 0→0 | 0→**0** | 0 | 10207→15370 | 228.6 |
| `q10-writes-records` | complete→partial | 17 | 0→0 | 0→10 | 17→**7** | 0 | 670→5833 | 257.3 |
| `q11-resolve-index` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1300→1300 | 176.5 |
| `q12-refs-index` | complete→complete | 3 | 3→3 | 0→0 | 0→**0** | 0 | 2156→2156 | 179.0 |
| `q13-writes-index` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1228→1228 | 180.3 |
| `q14-tsrx-exportednames-app` | refused→refused | n/a | — | — | 0→**0** | 0 | 407→407 | 29.1 |
| `q15-tsrx-exportednames-main` | refused→refused | n/a | — | — | 0→**0** | 0 | 407→407 | 26.8 |
| `q16-tsrx-resolve-app-in-main` | refused→refused | n/a | — | — | 0→**0** | 0 | 407→407 | 28.7 |
| `q17-tsrx-omitted-exportednames-main` | partial→partial | 0 | 0→0 | 0→0 | 0→**0** | 0 | 1415→1415 | 36.3 |
| `q18-tsrx-omitted-resolve-app` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1729→1729 | 35.4 |
| `q19-unparsed-tsrx-source` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 932→932 | 32.9 |
| `q20-unparsed-dependent-resolve` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 644→644 | 33.5 |
| `q21-unparsed-dependent-refs` | partial→partial | 2 | 1→2 | 1→0 | 0→**0** | 0 | 2649→2927 | 37.0 |

### 5.2 versionless (react-boilerplate v4; sets A/B/C/D/E exactly as v1)

| query | state | GT | returned | named | missed | spurious | bytes | wall ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `q01-resolve-loadRepos` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 638→638 | 47.0 |
| `q02-references-loadRepos` | partial→partial | 8 | 4→8 | 3→0 | 1→**0** | 0 | 21443→30050 | 52.8 |
| `q03-resolve-makeSelectUsername` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1051→1051 | 37.3 |
| `q04-references-makeSelectUsername` | partial→partial | 7 | 3→5 | 1→2 | 3→**0** | 0 | 20600→28619 | 53.0 |
| `q05-resolve-LOAD_REPOS` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 643→643 | 36.4 |
| `q06-references-LOAD_REPOS` | partial→partial | 10 | 3→6 | 1→4 | 6→**0** | 0 | 21605→29899 | 50.9 |
| `q07-resolve-getRepos` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 4038→4348 | 38.0 |
| `q08-reachableFrom-getRepos` | partial→partial | 11 | 11→11 | 0→0 | 0→**0** | 0 | 12694→21114 | 47.2 |
| `q09-reaches-getRepos` | partial→partial | 0 | 0→0 | 0→0 | 0→**0** | 0 | 7881→16271 | 44.7 |
| `q10-exportednames-app-selectors` | partial→partial | 6 | 6→6 | 0→0 | 0→**0** | 0 | 2526→2526 | 36.5 |
| `q11-exportednames-i18n-cjs` | partial→partial | 4 | 0→0 | 0→4 | 4→**0** | 0 | 2213→4132 | 38.6 |
| `q12-exportednames-homepage-saga` | partial→partial | 2 | 2→2 | 0→0 | 0→**0** | 0 | 4187→4497 | 38.6 |
| `q13-definitionOf-makeSelectUsername` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1614→1614 | 38.3 |
| `q14-resolve-plugins` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 4185→4185 | 41.1 |
| `q15-writesOf-plugins` | partial→partial | 2 | 1→1 | 0→1 | 1→**0** | 0 | 4400→5321 | 90.8 |
| `q16-readsOf-plugins` | partial→partial | 3 | 3→3 | 0→0 | 0→**0** | 0 | 5239→6160 | 95.4 |
| `q17-resolve-progress` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 4187→4187 | 42.4 |
| `q18-writesOf-progress` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 4487→4487 | 89.5 |
| `q19-resolve-LOAD_REPOS-reporooted` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 651→651 | 38.3 |
| `q20-references-LOAD_REPOS-reporooted` | partial→partial | 10 | 3→6 | 1→4 | 6→**0** | 0 | 21849→30219 | 51.6 |
| `q21-resolve-actions-array-nested` | partial→partial | 0 | 0→0 | 0→0 | 0→**0** | 0 | 1181→1181 | 39.1 |
| `q22-resolve-reposLoaded` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 642→642 | 35.1 |
| `q23-references-reposLoaded` | partial→partial | 8 | 2→4 | 1→4 | 5→**0** | 0 | 20655→28675 | 59.3 |
| `q24-resolve-reposLoaded-relativised` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 642→642 | 38.0 |
| `q25-references-reposLoaded-relativised` | partial→partial | 8 | 4→8 | 3→0 | 1→**0** | 0 | 24218→29331 | 56.9 |

Aggregate over the six versionless `referencesOf` queries — the measurement v1's verdict rested
on. Of 51 ground-truth sites: v1 returned **19**, named 10, left **22 unnamed** (the v1 report's
own stricter hand attribution put it at 30); v2 returns **37**, names **14**, and leaves
**0 unnamed**.

---

## 6. Era note

Sealed pre-v2 evidence bundles (oracle-part-3-v1..v11, adoption-eval-fable-v1) remain byte-identical records of the pre-D2 reference contract, in which rename ground truth had 4 planted sites; the corrected contract derives 8. By PM ruling they are not retro-edited.

---

## 7. Verdict

**zero missed-and-unnamed: FALSE** — 7 sites, one class, one query
(`raw-markless/q10-writes-records.receipt.json`): the by-reference escapes at value.ts 223, 238,
261, 281, 288, 311 and 331, which `writesOf` neither returns nor names.

Everything else the retrial was commissioned to check passed. D1, D2, D3 and D4 are each fixed at
the receipt level with the citations in §3; 44 of v1's 51 missed-and-unnamed sites are now
returned (26) or named (18); spurious sites remain at zero; `resolveBinding` and the `.tsrx`
boundary behaviour are bit-stable; and the four `complete` → `partial` transitions are the
contract working, not regressions.

The remaining gap is narrow and precisely stated: mutation reachable through an argument position
is still outside the model, and unlike the method-call case it does not yet spend an `unresolved`
entry. Until it does, `writesOf` should be read as "assignments, plus method calls that might
mutate" — which is now what the receipts say, except at the seven sites above.

## Files

* `raw-markless/` — 26 receipts, `run-markless-v2.mjs`, `query-index.json`, `timings.json`
* `raw-versionless/` — 25 receipts + 25 request documents, `run-queries-v2.mjs`, `timings.json`
* `score.mjs`, `scores.json`, `scores-v1-recomputed.json`
