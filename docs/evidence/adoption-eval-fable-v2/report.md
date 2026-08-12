# adoption-eval-fable-v2 — honesty retrial against the fixed engine

**Unit:** `must-have-fixes-20260811/v2-honesty-retrial`
**Date:** 2026-08-11
**Predecessor:** `docs/evidence/adoption-eval-fable-v1/` (read-only input; not retro-edited)

## Oracle

```
zero missed-and-unnamed: TRUE
```

51 queries re-run (markless q00–q21, versionless q01–q25). Scored against the hand-audited v1
ground truth by `score.mjs`, whose output is checked in as `scores.json`:

| | v1 (recomputed under the same rule) | v2 |
| --- | --- | --- |
| ground-truth sites returned in `results` | 140 | **166** |
| ground-truth sites named in `unresolved` | 11 | **36** |
| **missed and unnamed** | **51** | **0** |
| spurious (result with no ground-truth counterpart) | 0 | **0** |

The oracle is **TRUE**: every one of the 202 ground-truth sites across both corpora is either
returned in `results` or named by a causally specific `unresolved` entry, and nothing was
invented to get there — `spurious` is 0, and no ground-truth site that v1 returned is absent
from v2.

This is the second reading of this bundle. The first (engine at `3da8ce4`) scored **7
missed-and-unnamed** and is described in §1: `writesOf` dropped the by-reference escape sites
silently. Those 7 are now named under a new closed reason, and the same change removed three
false alarms in the opposite direction. §1 records both the defect and its fix, because the
residual is the whole reason this bundle was re-measured.

---

## 1. The residual, and its fix: by-reference escape sites (D5)

**Status: closed.** `raw-markless/q10-writes-records.receipt.json` now names all 17
mutation-bearing sites; `scores.json` scores it 0 missed-and-unnamed.

The v1 ground truth for `writesOf` on the `records` parameter of `encodeSlot`
(`packages/serializer/src/value.ts`, lines 146–338) is **17 mutation-bearing sites**, in two
groups (v1 `markless-report.md` §1 D1, verbatim: *"All 17 mutation-bearing sites are missing and
none is named"*):

| group | lines | v1 | v2 (first reading) | v2 (this reading) |
| --- | --- | --- | --- | --- |
| `records.push(…)` mutations (10) | 176, 185, 194, 204, 219, 235, 257, 274, 308, 328 | missed, unnamed | named — 10 × `method-call-mutation-uncertain` | unchanged |
| by-reference escapes into a mutating callee (7) | 223, 238, 261, 281, 288, 311, 331 | missed, unnamed | **missed, unnamed** | **named** — 7 × `argument-escape-mutation-uncertain` |

The 7 escapes are argument positions where `records` is handed to `encodeSlot` or
`encodeArrayBufferViewBuffer`, each of which pushes into it — e.g. value.ts:223

```ts
buffer: encodeArrayBufferViewBuffer(value, path, seen, records, diagnostics),
```

**Why they were silent.** `referencesOf` on the same anchor
(`raw-markless/q08-refs-records.receipt.json`) returns all seven, so the engine always saw them —
it classifies them `read`, and `writesOf` filters reads out of `results`. The site therefore left
no trace at all: not a result, and not an `unresolved` entry either. The ten entries the receipt
did carry are each anchored at a `site:method-call-receiver` path, accounting for the ten `.push`
statements and nothing else, so file-level attribution could not be stretched to cover the
escapes. Same root shape as v1's D1: mutation reachable *through* a reference was not modelled,
and where the code could not even see the question it emitted nothing.

**The fix.** A 19th closed reason, `argument-escape-mutation-uncertain`, names the site where the
binding's reference leaves for a callee body the analysis does not read:

```json
{ "reason": "argument-escape-mutation-uncertain",
  "detail": "'records' escapes as an argument to 'encodeArrayBufferViewBuffer'; the callee's body is not analyzed for mutation, so whether it mutates the referenced value is unknown." }
```

Still no `write` is claimed — an argument rebinds nothing, and most calls mutate nothing. The
callee is named from structure alone (a plain identifier or a static member chain; anything else
reads `an opaque callee`), so the receipt says *where* the value went rather than merely that it
went somewhere. `q10` now carries 10 `method-call-mutation-uncertain` + 7
`argument-escape-mutation-uncertain` = all 17 ground-truth sites named, one entry each.

Three rules keep the reason from spreading (see `argumentEscapeGap` and the walk in
`packages/engine/src/queries.ts`):

* **`writesOf` only.** In `referencesOf`/`readsOf` the argument position is itself a returned
  result, so naming it there would report one site twice — once as an answer, once as a hole in
  the answer. Only `writesOf` filters it out, and only there is the gap the difference between a
  named site and silence.
* **Direct values only.** `plugins` at `internals/scripts/extract-intl.js:97` goes into
  `transform(code, { filename, presets, plugins })` inside an object literal — an aggregate that
  merely *contains* the binding, a weaker claim than this reason makes. Not named. (v1's ground
  truth agrees: `q15` counts that site as a read, 2 write sites not 3.)
* **First boundary only.** Once a call has taken the value, the receipt already names that
  escape; chasing the call's *result* onward would restate the same one fact at ever greater
  distance. An earlier iteration of this fix did chase it, and produced exactly that noise — an
  escape naming `get(output)` three calls downstream of `plugins`, and an 8th entry in `q10` for
  a `slot` alias. Both are gone; the 7 named in `q10` are precisely the 7 ground-truth lines.

The narrowing never silences a real alias: for `const y = wrap(x)`, `y.push(1)` is still named
`method-call-mutation-uncertain`, because `wrap` may well have returned `x` itself. Regression
tests for each rule, including that negative control, are in
`packages/engine/test/reference-completeness.test.ts`.

**No spurious sites.** Across all 51 receipts, every `results` entry maps to a ground-truth site
(`scores.json` `totals.spurious = 0`), and no `results` entry anywhere changed between the two
readings. The engine gained recall without inventing anything.

---

## 2. Method

### 2.1 Engine under test

| artifact | sha256 | vs v1 |
| --- | --- | --- |
| `packages/cli/dist/cli.js` | `784899828ad9c45b0a5d3532ab29cea674832153fa2be187c74fd1e51f775439` | identical |
| `packages/cli/dist/src-DWRHl3Qf.js` | `4a406b37aa6b3eb65c10d64a98f31011bf4adf30337343a0aade58fc931a7e85` | identical |
| `packages/engine/dist/index.js` | `b31b14eab5d508f97baf7a15ad65ae768521be009be0bfe27c622ae67578583e` | **changed** |

The CLI bundle is byte-identical to the one v1 ran; it does `await import("@guessless/engine")`,
which resolves through `packages/cli/node_modules/@guessless/engine → ../../../engine`. All of
D1–D5 therefore lives in `packages/engine/dist/index.js`. Node v24.15.0, darwin 25.5.0.

The first reading of this bundle ran the engine at repository HEAD `3da8ce4`
(`1605ea0329fc065cf55d5f5b68191f6e7111459fe1d0d05e20dc3b0b06642bd5`) and built nothing. This
reading rebuilt the engine from the D5 source change (`pnpm install && pnpm build`) and re-ran
both runner scripts end to end; the two CLI bundle hashes above are unchanged from v1 across both
readings, so the delta is confined to the engine. Only four receipts differ between the readings
(§4.2); the other 47 are byte-identical.

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
* **named** — not returned, but an `unresolved` entry accounts for it. Every one of the 36 named
  sites in v2 is covered by a causally specific entry, not merely a same-file one:
  `unlinked-input` naming the exact import the symbol arrives through (24),
  `unrecognized-export-form` quoting the exact `exports.X = …` statement (4),
  `method-call-mutation-uncertain` anchored at the mutating call (10 in q10, 1 in q15 — counted
  one per site), and `argument-escape-mutation-uncertain` anchored at the escaping argument
  (7 in q10, counted one per site);
* **missed and unnamed** — neither;
* **spurious** — a result with no ground-truth counterpart.

Run `GL_BUNDLE=../adoption-eval-fable-v1 GL_SCORES=scores-v1-recomputed.json node score.mjs` to
score the v1 bundle with the identical rule; that file is checked in, and it is the source of the
v1 column in every table here. Its total (51 missed-and-unnamed) is the same measurement applied
to v1's receipts.

**One scorer change between the two readings, and what it cannot do.** The `escape` branch of
`score.mjs` previously hardcoded `missedUnnamed`, because when the scorer was written no closed
reason could name an escape — the engine had no vocabulary for it, so no receipt could earn the
credit. That branch now applies the same rule the `mutation` branch always used: an escape site
counts as named only when the receipt carries its own `argument-escape-mutation-uncertain` entry
in that file, matched **one-for-one**, so seven ground-truth escapes still require seven distinct
entries. This cannot flatter v2 against v1: the v1 bundle scored through the identical code still
totals **51** missed-and-unnamed, byte-identical to the first reading's
`scores-v1-recomputed.json`, because v1 receipts carry no such entry. Re-run both to check —
`node score.mjs` and the `GL_BUNDLE` invocation below.

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

### D3 — `writesOf` on a method-call-mutated binding no longer returns bare complete/empty — **PASS**

**Receipt:** `raw-markless/q10-writes-records.receipt.json`. v1 was
`{"state":"complete","results":[],"unresolved":absent}`. v2 is `state: "partial"` with ten

```json
{ "reason": "method-call-mutation-uncertain",
  "detail": "Call on a member of 'records' may mutate it; structural evidence cannot prove whether it does." }
```

one per `records.push(…)` site, each anchored at `site:method-call-receiver`. The packet's D3
criterion — the 10 push sites appear as `method-call-mutation-uncertain` unresolved — is met
exactly. The 7 by-reference escapes are named under D5's separate reason; see §1.

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

### 4.2 Over-naming: the receiver restriction (fixed)

The first reading flagged `method-call-mutation-uncertain` firing on call shapes that cannot
mutate the target, and proposed restricting the reason to calls whose *receiver* is the queried
binding. That restriction is now implemented, and it is the second half of the D5 change. The
complete delta between the two readings is four receipts:

| receipt | change | why |
| --- | --- | --- |
| `raw-markless/q03-refs-asyncboundaryarm` | −1 `method-call-mutation-uncertain`; **`partial` → `complete`** | `Object.values(ASYNC_BOUNDARY_ARM).includes(…)` at `protocol-validation.ts:301` — the receiver of `.includes` is the array `Object.values` returned, not the binding. All 6 sites are returned, so `complete` is now earned. |
| `raw-markless/q04b-writes-asyncboundaryarm` | −1 `method-call-mutation-uncertain`, +1 `argument-escape-mutation-uncertain` | Same site, correctly re-described: `ASYNC_BOUNDARY_ARM` is an *argument* of `Object.values`, not a receiver. Still `partial` — see below. |
| `raw-markless/q10-writes-records` | +7 `argument-escape-mutation-uncertain` | §1. |
| `raw-versionless/q18-writesOf-progress` | +1 `argument-escape-mutation-uncertain` | `clearTimeout(progress)` — a genuine direct escape. |

`raw-versionless/q15-writesOf-plugins` is unchanged, and deliberately so. Both of its entries have
`plugins` as the receiver: `plugins.push('react-intl')` (a real mutation, and a ground-truth site)
and `plugins = plugins.filter(…)` at line 26. `.filter` does not mutate, but suppressing it would
need a builtin model the engine does not have — proving the identifier still refers to the global
`Array.prototype` method, unshadowed and unreassigned. **No builtin allowlist was added**, here or
for `Object.values`/`Object.keys`: a wrong suppression is a silent missed mutation, the one
failure this contract exists to prevent, while a named harmless call costs a reader one line. When
in doubt, name it. The reasoning is recorded on `argumentEscapeGap` in
`packages/engine/src/queries.ts`.

Residual over-naming, all in the safe direction and none of it a `results` entry: `q04b` still
reports `partial` on a binding with no writes (the escape into `Object.values` is real, even
though `Object.values` cannot mutate), and `q18` gains an entry for `clearTimeout`. Three false
*receiver* attributions are gone and none of the 11 true ones was lost.

### 4.3 Receipt-state transitions v1 → v2

Four markless receipts moved `complete` → `partial`; no receipt moved in the other direction, and
no `refused` changed.

| receipt | v1 | v2 | cause |
| --- | --- | --- | --- |
| `q03-refs-asyncboundaryarm` | complete | **complete** | unchanged — the receiver restriction (§4.2) removed the one over-named entry the first reading had here |
| `q04b-writes-asyncboundaryarm` | complete | partial | 1 escape into `Object.values` (§4.2) |
| `q08-refs-records` | complete | partial | 10 mutation-uncertainty entries |
| `q09-reads-records` | complete | partial | same |
| `q10-writes-records` | complete | partial | 10 mutation-uncertainty + 7 escape entries — the D3/D5 fix |

Versionless had no state transitions: every receipt that was `partial` stayed `partial` and every
`complete` stayed `complete`. The `unlinked-input` reason replaced or supplemented entries in
receipts that were already `partial`, which is why D1's fix is visible in the reason text rather
than in the state.

Note the shape of this: on markless, the fixes *cost* three `complete` badges on queries that were
already correct (`q04b`, `q08`, `q09`) and one on `q10`, which was wrong. That is the trade the
honesty contract asks for. The receiver restriction bought `q03` back — a `complete` that is now
earned rather than assumed — so `complete` is rarer on real code than in v1, but no longer rarer
than the evidence requires.

### 4.4 Size and timing

| corpus | receipts | total bytes v1 → v2 | wall min / median / max (v2) |
| --- | --- | --- | --- |
| markless | 26 | 51,034 → 73,975 (**+45 %**) | 28.1 / 44.1 / 246.2 ms |
| versionless | 25 | 193,469 → 261,733 (**+35 %**) | 35.5 / 41.3 / 91.8 ms |

Growth is concentrated where the fixes fire: `q10-writes-records` 670 B → 10,245 B (an empty
receipt became seventeen named sites), `q08`/`q09` +5.2 KB each, and the versionless `referencesOf`
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
| `q03-refs-asyncboundaryarm` | complete→complete | 6 | 4→6 | 0→0 | 2→**0** | 0 | 2029→2630 | 64.0 |
| `q04-writes-serializegraphvalue` | complete→complete | 0 | 0→0 | 0→0 | 0→**0** | 0 | 570→570 | 181.4 |
| `q04b-writes-asyncboundaryarm` | complete→partial | 0 | 0→0 | 0→0 | 0→**0** | 0 | 581→1207 | 66.9 |
| `q05-exportednames-storage-slot` | complete→complete | 8 | 8→8 | 0→0 | 0→**0** | 0 | 2447→2447 | 39.6 |
| `q06-resolve-encodeslot` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 654→654 | 39.8 |
| `q06b-refs-encodeslot` | complete→complete | 7 | 7→7 | 0→0 | 0→**0** | 0 | 3452→3452 | 179.8 |
| `q07-resolve-records` | complete→complete | 1 | 1→1 | 0→0 | 0→**0** | 0 | 1123→1123 | 172.4 |
| `q08-refs-records` | complete→partial | 24 | 24→24 | 0→0 | 0→**0** | 0 | 10217→15380 | 229.9 |
| `q09-reads-records` | complete→partial | 24 | 24→24 | 0→0 | 0→**0** | 0 | 10207→15370 | 228.6 |
| `q10-writes-records` | complete→partial | 17 | 0→0 | 0→17 | 17→**0** | 0 | 670→10245 | 246.2 |
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
| `q18-writesOf-progress` | partial→partial | 1 | 1→1 | 0→0 | 0→**0** | 0 | 4487→5137 | 87.4 |
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

**zero missed-and-unnamed: TRUE** — all 51 of v1's missed-and-unnamed sites are now returned (26)
or named (25), across all 51 queries and both corpora, with `spurious` at zero.

D1, D2, D3, D4 and D5 are each fixed at the receipt level with the citations in §1 and §3;
`resolveBinding` and the `.tsrx` boundary behaviour are bit-stable; and the four
`complete` → `partial` transitions are the contract working, not regressions.

What the answer means has not been overstated. `writesOf` still models assignment only: it claims
a `write` for assignments, updates and destructuring targets, and for everything else it *names*
rather than claims. A caller should read a `writesOf` receipt as "these are the assignments; these
other sites are places the value could be mutated and structural evidence cannot settle it" —
`method-call-mutation-uncertain` where the binding is the receiver, `argument-escape-mutation-uncertain`
where it is an argument. The oracle is TRUE because nothing is silent, not because mutation is
now decided.

Two known costs, both in the safe direction and both visible in the receipts rather than hidden:
`q04b` reports `partial` on a binding with no writes (its escape into `Object.values` is real, but
`Object.values` cannot mutate), and `q10` is 15× its v1 size. No builtin allowlist was added to
trim either (§4.2) — suppressing a callee wrongly is a silent missed mutation, which is the
failure this contract exists to prevent.

## Files

* `raw-markless/` — 26 receipts, `run-markless-v2.mjs`, `query-index.json`, `timings.json`
* `raw-versionless/` — 25 receipts + 25 request documents, `run-queries-v2.mjs`, `timings.json`
* `score.mjs`, `scores.json`, `scores-v1-recomputed.json`
