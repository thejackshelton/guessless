# Guessless honesty trial against markless — scored report

**Run:** `adoption-eval-20260811/markless-receipts`
**Date:** 2026-08-11
**Engine under test:** `/Users/jacksm5pro/dev/open-source/guessless/packages/cli/dist/cli.js`
(sha256 `78489982…5439`; bundle `src-DWRHl3Qf.js` sha256 `4a406b37…7a85`). Not rebuilt.
**Corpus:** `/Users/jacksm5pro/dev/open-source/markless` @ `931f0544`, read-only.
**Node:** v24.15.0. **Host:** darwin 25.5.0.

Every receipt referenced below is stored verbatim in `raw-markless/*.receipt.json` — 26
receipts, 21 distinct queries. The query documents themselves are not checked in (they were
2.2 MB of duplicated markless source); `raw-markless/query-index.json` records, per receipt,
the exact ordered input paths, the exact request, the resulting `snapshot` hash, and the
state. Each document regenerates deterministically from the fileset + request files and the
helper scripts in §2.2, and the `snapshot` hash in each receipt pins its input set, so any
regenerated document can be checked against the receipt it produced.

---

## 1. Headline: two missed-and-unnamed defect classes

The packet asks that any site which is **both missed and not named in `unresolved`** lead the
report. Two such classes occurred. Neither is a random dropout — both are systematic, which
makes them cheaper to fix and more dangerous to trust in the meantime, because an agent that
sees `"state": "complete"` has no signal at all that a category of site was excluded.

### D1 — `writesOf` returns `complete` with zero results on a binding mutated ten times

**Receipt:** `raw-markless/q10-writes-records.receipt.json`

```json
{ "state": "complete", "query": "writesOf", "results": [] }
```

Target: the `records` parameter of `encodeSlot` in
`packages/serializer/src/value.ts` (resolved by the engine itself in
`q07-resolve-records.receipt.json`, anchor `…symbol:records / declaration:FunctionDeclaration`).

Ground truth inside `encodeSlot` (lines 146–338): **10 `records.push(…)` mutation sites** at
lines 176, 185, 194, 204, 219, 235, 257, 274, 308, 328, plus **7 escapes** where `records` is
passed by reference into a recursive `encodeSlot` / `encodeArrayBufferViewBuffer` call
(lines 223, 238, 261, 281, 288, 311, 331) — every one of which mutates it.

`writesOf` returned **0 results, `state: complete`, `unresolved` absent**. All 17
mutation-bearing sites are missing and none is named. `referencesOf` on the same anchor
(`q08-refs-records.receipt.json`) returns all 24 sites and labels **every one of them
`"access": "read"`, including the ten `.push` calls.**

This is a direct contradiction of the product's own documented surface. `README.md`:

> | `writesOf` | References that write **or may mutate** a symbol. |

The engine implements assignment-only. `packages/engine/src/queries.ts:100`:

```ts
function referenceAccess(reference: Reference): ReferenceResult['access'] {
	return reference.isWrite ? expressionAccess(reference.module, reference.node, 'write') : 'read';
}
```

`reference.isWrite` is binding-assignment from the underlying analyzer; a member call on the
binding is not an assignment, so `records.push(x)` classifies as `read`. There is no
`unresolved` reason emitted for "this binding escapes and may be mutated through the
reference", so the gap is invisible.

The failure is not that `writesOf` is broken. It is precise on genuine reassignment — see the
control, D1-control below. The failure is that a query documented as "may mutate" answers a
strictly narrower question and reports the narrow answer as `complete`. An agent asking
"is anything mutating `records`?" is told, with a signed integrity hash, *no*.

**D1-control (proves `writesOf` works and the zero above is a semantic gap, not a crash).**
`q13-writes-index.receipt.json`: target is the `let index` declared in `encodeSlot`'s
`value instanceof Map` branch (value.ts:275). `writesOf` returns `state: complete`, 1 result,
`access: "read-write"` — the `index++` at line 297 — and correctly excludes the *separate*
`let index` in the `Set` branch at line 305. `referencesOf` on the same anchor
(`q12-refs-index.receipt.json`) returns exactly 3 sites (279, 286, 297), which is exact
ground truth for that block scope.

### D2 — `referencesOf` silently omits import specifiers and cross-module re-export specifiers

Across the three headline symbols, **7 genuine identifier occurrences of the target binding
were absent from `complete` receipts with an empty `unresolved` list**:

| File:line | Occurrence | In receipt? |
| --- | --- | --- |
| `protocol-validation-storage.ts:8` | `import { isValidStorageKey } from './storage-key.ts';` | no |
| `storage-record-client.ts:3` | `import { isValidStorageKey } from './storage-key.ts';` | no |
| `storage-slot.ts:1` | `export { isValidStorageKey } from './storage-key.ts';` | **no** |
| `protocol-state.ts:7` | `import { serializeGraphValue, … } from './value.ts';` | no |
| `resume-record-delta.ts:3` | `import { serializeGraphValue } from './value.ts';` | no |
| `protocol.ts:1` | `import { ASYNC_BOUNDARY_ARM } from './async-boundary-arm.ts';` | no |
| `protocol-validation.ts:2` | `ASYNC_BOUNDARY_ARM,` (in import block from `./protocol.ts`) | no |

Excluding *binding-introduction* sites from "references" is a defensible definition, and
excluding the declaration itself is standard (that is what `definitionOf` is for). Two things
stop this from being merely a definitional choice:

1. **It is undocumented.** `README.md` says only "referencesOf — All known references to a
   symbol." Nothing in `README.md`, `AGENTS.md`, or `docs/research/` states that import and
   re-export specifiers are not references. A receipt that says `complete` while silently
   applying an unpublished narrowing is exactly the "unqualified result list" the product
   positions itself against.
2. **It is internally inconsistent.** `q03-refs-asyncboundaryarm.receipt.json` **does** return
   the export specifier at `protocol.ts:4`
   (`export { ASYNC_BOUNDARY_ARM, … };` → semanticPath
   `…ExportNamedDeclaration > ExportSpecifier > Identifier`). But
   `q01-refs-isvalidstoragekey.receipt.json` does **not** return the export specifier at
   `storage-slot.ts:1` (`export { isValidStorageKey } from './storage-key.ts';`). The only
   difference is that the second carries a `from` source. Both are export specifiers naming
   the target binding; one is a reference and the other is not, with no reason given.

**Practical consequence.** An agent using `referencesOf` to enumerate the edit sites for a
rename of `isValidStorageKey` is handed 2 sites and told `complete`. Editing only those 2
leaves 3 broken sites and a build failure. Partial mitigation: `exportedNames` *does* list
re-exported names (proved by `q05`, which returns `isValidStorageKey` for `storage-slot.ts`),
so a caller who knows to also run `exportedNames` on every module can recover the re-export
edge. Nothing recovers the import specifiers.

---

## 2. Method

### 2.1 Input sets

The engine analyzes only the supplied inputs, so ground truth for every query below was
computed over **exactly** the set supplied to that query. Three sets were used.

**Set A — `@markless/serializer` sources (20 files, 3,648 LOC).** Listed verbatim in
`raw-markless/fileset-serializer.txt`, generated by:

```sh
cd /Users/jacksm5pro/dev/open-source/markless
find packages/serializer/src -name '*.ts' | sort
```

Set A is a **closed** module set — no file in it imports anything outside it. Verified by:

```sh
cd /Users/jacksm5pro/dev/open-source/markless/packages/serializer/src
grep -rhn "from '" --include="*.ts" . | grep -v "from './" | sort -u   # → empty
```

That closure is why `complete` is even reachable for Set A queries: `baseUnresolved` has no
external-module-boundary sites to report. Queries q00–q13 use Set A.

**Set B — `demos/live-feed/src` (boundary probes).**
`raw-markless/fileset-livefeed.txt` (4 files incl. 2 `.tsrx`) and
`raw-markless/fileset-livefeed-ts-only.txt` (2 `.ts` files). Queries q14–q18.

**Set C — synthetic re-pathing (boundary probes q19–q21).** The only synthetic inputs in the
trial. Real markless `.tsrx` source is supplied **verbatim** under a `.ts` path so the parser
actually attempts it instead of refusing on extension. Built by
`raw-markless/make-unparsed-probe.mjs` and `raw-markless/make-unparsed-dependent-probe.mjs`,
both of which document the single byte-level alteration made (one import specifier rewritten
from `'./update-feed'` to `'./update-feed.ts'` so the two supplied paths link).

### 2.2 Helper scripts (all under `raw-markless/`)

| Script | Role |
| --- | --- |
| `build-query.mjs` | Reads a file list + a request JSON, emits `{inputs, request}`. Reads markless only. |
| `run-query.sh` | Builds the doc, runs the CLI, writes `<label>.receipt.json`, prints wall ms + bytes. |
| `make-target-request.mjs` | Lifts `results[0]` out of a `resolveBinding` receipt into `{kind, target}`. No hand-authored anchors anywhere in this trial. |
| `make-scoped-resolve.mjs` | Uses an engine-produced *reference-site* anchor as the `scope` of a `resolveBinding`, which is how function-local and block-local bindings (`records`, `index`) were reached through the CLI surface. |
| `make-unparsed-probe.mjs`, `make-unparsed-dependent-probe.mjs` | Set C construction. |
| `query-index.json` | Per-receipt record of ordered input paths, request, `snapshot`, and state. |

Reproduce any Set A query:

```sh
bash docs/evidence/adoption-eval-fable-v1/raw-markless/run-query.sh \
  q01-refs-isvalidstoragekey fileset-serializer.txt req-refs-isvalidstoragekey.json
```

### 2.3 Ground-truth procedure

For each symbol, every identifier occurrence in the input set was enumerated with an exact
word-boundary scan and then **each hit was read in context** to separate true references from
same-name coincidences:

```sh
cd /Users/jacksm5pro/dev/open-source/markless/packages/serializer/src
grep -rnoE "\bisValidStorageKey\b" --include="*.ts" .      # site list
grep -rooE "\bisValidStorageKey\b" --include="*.ts" . | wc -l   # occurrence count
```

The `\b…\b` anchors matter: `_` is a word character, so `ASYNC_BOUNDARY_ARM_MIN`,
`ASYNC_BOUNDARY_ARM_PENDING`, and `ASYNC_BOUNDARY_ARM_MAX` (all real, all in
`protocol-constants.ts`) are correctly excluded from `ASYNC_BOUNDARY_ARM`'s ground truth.

Receipt results carry no line numbers — a site is identified by `file` plus an AST
`semanticPath`. Each returned site was mapped back to a line by reading the file and matching
the path shape, e.g. `Program > ExportNamedDeclaration > FunctionDeclaration > BlockStatement >
ReturnStatement > ObjectExpression > Property > CallExpression > ArrowFunctionExpression >
BlockStatement > VariableDeclaration > VariableDeclarator > CallExpression > Identifier`
uniquely identifies `protocol-state.ts:96`. All mappings below were done this way.

---

## 3. Symbol 1 — `isValidStorageKey` (structurally tricky: two-hop re-export)

Declared `packages/serializer/src/storage-key.ts:18`. Re-exported by `storage-slot.ts:1`
(`export { … } from`), which is itself star-re-exported by `index.ts:6`. Imported directly
from `storage-key.ts` by two other modules. Input set: **Set A**.

**Ground truth — 6 occurrences, all genuine references to one binding, no shadow, no coincidence:**

| # | Site | Kind | In receipt |
| --- | --- | --- | --- |
| 1 | `storage-key.ts:18` | declaration | n/a (`definitionOf`'s job) |
| 2 | `storage-slot.ts:1` | re-export specifier w/ source | **missed, unnamed** |
| 3 | `protocol-validation-storage.ts:8` | import specifier | **missed, unnamed** |
| 4 | `protocol-validation-storage.ts:45` | call `!isValidStorageKey(record.key)` | ✅ |
| 5 | `storage-record-client.ts:3` | import specifier | **missed, unnamed** |
| 6 | `storage-record-client.ts:17` | call `!isValidStorageKey(entry.key)` | ✅ |

`index.ts:6` (`export * from './storage-slot.ts';`) re-exports the name transitively but
produces no identifier occurrence, so it is not a site.

**Scoring**

| | |
| --- | --- |
| `resolveBinding` (`q00-resolve-isvalidstoragekey`) | `complete`, 1 anchor, correct file + `symbol:isValidStorageKey / declaration:FunctionDeclaration`. ✅ |
| `referencesOf` (`q01-refs-isvalidstoragekey`) | `complete`, 2 results |
| Use-site recall | **2 / 2 (100%)** |
| Full-occurrence recall | 2 / 5 non-declaration sites |
| Spurious | **0** |
| Missed **and** unnamed | **3** (sites 2, 3, 5) — see D2 |
| `unresolved` accounts for gaps? | No `unresolved` present; state is `complete`. |

---

## 4. Symbol 2 — `serializeGraphValue` (re-exported through a barrel; multiple call sites)

Declared `packages/serializer/src/value.ts:122`. Reachable from `index.ts:7`
(`export * from './value.ts'`). Input set: **Set A**.

**Ground truth — 7 occurrences:**

| # | Site | Kind | In receipt |
| --- | --- | --- | --- |
| 1 | `value.ts:122` | declaration | n/a |
| 2 | `protocol-state.ts:7` | import specifier | **missed, unnamed** |
| 3 | `protocol-state.ts:96` | call in `createProtocolStatePayload` | ✅ (result 1) |
| 4 | `protocol-state.ts:129` | call in `serializeRuntimeStateCells` | ✅ (result 0) |
| 5 | `protocol-state.ts:210` | call in `serializeProtocolStateField` | ✅ (result 2) |
| 6 | `resume-record-delta.ts:3` | import specifier | **missed, unnamed** |
| 7 | `resume-record-delta.ts:225` | call in `durableComparisonValue` | ✅ (result 3) |

Result→line mapping is unambiguous: result 1's path runs `ReturnStatement > ObjectExpression >
Property > CallExpression > ArrowFunctionExpression` (the `cells: input.cells.map(…)` property
at line 96); result 0's runs `ReturnStatement > CallExpression > ArrowFunctionExpression`
(the bare `return cells.map(…)` at 129); result 2 sits under a non-exported
`FunctionDeclaration` (`serializeProtocolStateField`, 210).

**Scoring**

| | |
| --- | --- |
| `resolveBinding` (`q00-resolve-serializegraphvalue`) | `complete`, correct anchor. ✅ |
| `referencesOf` (`q02-refs-serializegraphvalue`) | `complete`, 4 results |
| Use-site recall | **4 / 4 (100%)** |
| Spurious | **0** |
| Missed **and** unnamed | **2** (sites 2, 6) — see D2 |
| `writesOf` (`q04-writes-serializegraphvalue`) | `complete`, 0 results. **Correct** — a function declaration is never reassigned anywhere in Set A. |

---

## 5. Symbol 3 — `ASYNC_BOUNDARY_ARM` (two-hop import→re-export chain, type-position uses, near-miss neighbours)

Declared `packages/serializer/src/async-boundary-arm.ts:7`. `protocol.ts` imports it (line 1)
and re-exports it as a local binding (line 4). `protocol-validation.ts` then imports it
**from `protocol.ts`, not from the declaring module** — so resolving its use at line 301
requires following import → re-export → declaration. Input set: **Set A**.

**Ground truth — 7 occurrences:**

| # | Site | Kind | In receipt |
| --- | --- | --- | --- |
| 1 | `async-boundary-arm.ts:7` | declaration | n/a |
| 2 | `protocol.ts:1` | import specifier | **missed, unnamed** |
| 3 | `protocol.ts:4` | export specifier (local, no `from`) | ✅ (result 1) |
| 4 | `protocol.ts:6` | `typeof ASYNC_BOUNDARY_ARM` in `TSParenthesizedType` | ✅ (result 2) |
| 5 | `protocol.ts:6` | `keyof typeof ASYNC_BOUNDARY_ARM` in `TSTypeOperator` | ✅ (result 3) |
| 6 | `protocol-validation.ts:2` | import specifier (from `./protocol.ts`) | **missed, unnamed** |
| 7 | `protocol-validation.ts:301` | `Object.values(ASYNC_BOUNDARY_ARM).includes(…)` | ✅ (result 0) |

Correctly **not** counted as sites: `ASYNC_BOUNDARY_ARM_MIN` / `_PENDING` / `_MAX` in
`protocol-constants.ts` and `async-boundary-arm.ts` — different identifiers, prefix
coincidence only. The engine returned none of them.

**Scoring**

| | |
| --- | --- |
| `resolveBinding` (`q00-resolve-asyncboundaryarm`) | `complete`, correct anchor. ✅ |
| `referencesOf` (`q03-refs-asyncboundaryarm`) | `complete`, 4 results |
| Use-site recall | **4 / 4 (100%)**, including both type-position uses on one line and the cross-module use reached through a two-hop re-export chain |
| Spurious | **0** |
| Missed **and** unnamed | **2** (sites 2, 6) — see D2 |
| `writesOf` (`q04b-writes-asyncboundaryarm`) | `complete`, 0 results. **Correct** — the `as const` object binding is never reassigned in Set A. |

**This is the strongest positive result in the trial.** Following
`protocol-validation.ts:2` → `protocol.ts:4` → `protocol.ts:1` → `async-boundary-arm.ts:7`
and then attributing the line-301 use to the original declaration is exactly the work that
grep cannot do and that a heuristic tool would get wrong. Guessless got it right, and it also
resolved both `typeof`/`keyof typeof` uses that share a single source line.

---

## 6. Additional Set A probes

### 6.1 `exportedNames` on a module with a re-export (`q05-exportednames-storage-slot`)

Ground truth for `packages/serializer/src/storage-slot.ts` — 8 exported names:
`isValidStorageKey` (re-exported, line 1), `STORAGE_SLOT_SYMBOL_KEY` (3),
`storageAttributeName` (10), `StorageSeedMetadata` (type, 14), `storageSlotEntryKey` (20),
`storageSlotEntryKeyFromGraphNodeId` (24), `createStorageSeedMetadata` (28),
`createStorageSeedMetadataFromGraphNodeId` (44).

Receipt: `complete`, **8 / 8 exact**, 0 spurious, 0 missing — types and re-exported names
included. ✅

### 6.2 Same-name discrimination: `records` (`q07`, `q08`, `q09`, `q10`)

`value.ts` contains **three distinct bindings named `records`** plus one type property of the
same name — `SerializedGraphPayload.records` (line 92, a type member), a `const records` local
to `serializeGraphValue` (125, used at 127 and 140), the `encodeSlot` parameter (150), and the
`encodeArrayBufferViewBuffer` parameter (364, used at 373). Ground truth for the
**`encodeSlot` binding only**: 24 non-declaration occurrences inside lines 146–338, split as
7 `records.length` reads (174, 183, 192, 202, 217, 233, 248), 10 `.push` mutations (176, 185,
194, 204, 219, 235, 257, 274, 308, 328), and 7 by-reference argument passes (223, 238, 261,
281, 288, 311, 331).

| Query | Result | Score |
| --- | --- | --- |
| `resolveBinding` scoped (`q07`) | `complete`, anchor under `function:scope:…FunctionDeclaration…/symbol:records` | ✅ |
| `referencesOf` (`q08`) | `complete`, **24 / 24 exact**, 0 spurious, none of the other three same-name bindings leaked in | ✅ **best-in-trial precision** |
| `readsOf` (`q09`) | `complete`, 24 results — identical to `referencesOf`, because all 24 are classified `read` | ✅ defensible: `records.push(x)` really does read the binding before mutating the object it names. `readsOf` is not wrong here; `writesOf` is where the information is lost |
| `writesOf` (`q10`) | `complete`, **0 results** vs 10 mutations | ❌ **D1** |

### 6.3 Block-scope discrimination: `index` (`q11`, `q12`, `q13`)

Two separate `let index` bindings exist in `encodeSlot` (Map branch line 275, Set branch line
305). Scoped `resolveBinding` reached the Map-branch one (anchor carries an explicit
`block:scope:…IfStatement>BlockStatement…` segment). `referencesOf` returned **3 / 3 exact**
(279, 286, 297) with zero leakage from the Set branch; `writesOf` returned the single
`index++` at 297 with `access: "read-write"`. Both `complete`, both correct. ✅

### 6.4 `encodeSlot` recursion (`q06`, `q06b`)

`referencesOf(encodeSlot)` → `complete`, **7 / 7 exact** (line 127 in `serializeGraphValue`;
261, 281, 288, 311, 331 recursive inside `encodeSlot`; 373 in
`encodeArrayBufferViewBuffer`), 0 spurious. ✅

---

## 7. `.tsrx` boundary probes

Markless's own source language is `.tsrx` — TypeScript with an `@{` reactive-body form and
inline markup, e.g. `export function App() @{ … <main class="live-feed">…</main> }`. This does
not parse as TypeScript. There are **6,263 `.tsrx` files** in the markless tree, so the
boundary is not an edge case for this corpus; it is the corpus.

### 7.1 A real `.tsrx` file in the inputs → whole batch refused (`q14`, `q15`, `q16`)

Inputs: Set B (`App.tsrx`, `UpdateSummary.tsrx`, `main.ts`, `update-feed.ts`). Three different
requests were sent — `exportedNames` on the `.tsrx`, `exportedNames` on the `.ts`, and
`resolveBinding` inside the `.ts`. All three returned the **identical** receipt:

```json
{
  "state": "refused",
  "query": "addFile",
  "request": { "kind": "addFile", "file": "demos/live-feed/src/App.tsrx" },
  "reason": "unsupported-language",
  "detail": "Unsupported language for 'demos/live-feed/src/App.tsrx'.",
  "results": []
}
```

CLI exit code **1**, stderr `guessless: an input file was refused by the engine`.

Observations, in order of importance:

- **It refuses rather than guesses.** No partial answer, no silently-dropped file. Correct
  under the honesty contract, and it is a *closed* reason (`unsupported-language`).
- **Refusal is whole-batch, not per-file.** One unsupported input poisons the entire query,
  including the parts of it that concern only `.ts` files. `q15` asked about `main.ts` and got
  back a receipt about `App.tsrx`.
- **The `query` field reports `addFile`, not the requested query,** and `request` is rewritten
  to a synthetic `addFile` request. A caller correlating receipts to its own requests will not
  find its request echoed back. Worth noting for MCP/agent integrations that key on
  `receipt.request`.
- **Adoption consequence.** Any tool that hands guessless a directory containing `.tsrx` gets
  nothing at all. Callers must pre-filter by extension, and that pre-filtering is exactly what
  produces the invisibility described in §7.4.

### 7.2 `.tsrx` omitted from inputs → `partial` with the boundary named (`q17`, `q18`)

Inputs: `main.ts` + `update-feed.ts` only. `main.ts` does `import App from './App.tsrx';`.

`q17` (`exportedNames` on `main.ts`): `state: partial`, `results: []` (correct — `main.ts`
exports nothing), and **three** named `unresolved` sites:

| site | reason | detail |
| --- | --- | --- |
| `ImportDeclaration > ImportDefaultSpecifier` | `unresolved-specifier` | `Import './App.tsrx' leaves the linked file set.` |
| `ImportDeclaration > ImportSpecifier` | `external-module-boundary` | `Import '@markless/core' leaves the linked file set.` |
| `ImportDeclaration` | `unresolved-specifier` | `Import './styles.css' leaves the linked file set.` |

`q18` (`resolveBinding App` in `main.ts`): `state: partial`, and it **does** return an anchor
(`symbol:App / declaration:ImportDefaultSpecifier`) while simultaneously naming the same three
boundaries. That is the right shape: a useful, honestly-qualified answer.

**This is the honesty contract working exactly as advertised.** ✅

### 7.3 Unparseable source under a `.ts` path → `partial` (`q19`)

Set C. Real `App.tsrx` source under `probe/App-as-ts.ts`, plus a syntactically valid
`probe/main-shim.ts` importing its default. Receipt: `state: partial`, anchor returned, one
`unresolved`:

```json
{ "reason": "unresolved-symbol", "detail": "Module './App-as-ts.ts' has no export 'default'" }
```

Correct state, but the *reason chosen is the second-best one*. The truth is that
`App-as-ts.ts` does not parse; the receipt says it has no default export. A caller could
reasonably conclude the export was deleted rather than that the module is unreadable. The
narrower closure for `resolveBinding` (`relevant = new Set([module])`,
`packages/engine/src/queries.ts:1082`) is why the dependency's parse diagnostics are not
surfaced here. Not a soundness failure — the site is named and the state is `partial` — but a
diagnostic-quality gap worth a fix.

### 7.4 The sharpest test: an **unparseable caller** — does `referencesOf` still say `complete`? (`q20`, `q21`)

This is the question that decides whether guessless is safe on a markless codebase. Set C
inputs: real `demos/live-feed/src/update-feed.ts` (parses) supplied as `probe/update-feed.ts`,
and real `demos/live-feed/src/App.tsrx` (does **not** parse) supplied as `probe/App-as-ts.ts`.
`App.tsrx` imports `fetchLocalUpdates` at its line 2 and calls it at line 13.

`referencesOf(fetchLocalUpdates)` → **`state: partial`**, 1 result (the call site, recovered by
error-tolerant parsing), and 5 `unresolved` entries including **two `unparsed-file` sites naming
`probe/App-as-ts.ts` by name**:

```json
{ "reason": "unparsed-file",
  "detail": "Expected a semicolon or an implicit semicolon after a statement, but found '@'" }
```

**The engine did not claim `complete` when a caller was unreadable, and it named the
unreadable file.** This is the single most important result in the trial and it is a pass. ✅
(`resolveBinding` on the same set, `q20`, returned `complete` — correct, since the queried
module itself parses cleanly and the anchor is unambiguous — though a caller reading only that
receipt gets no hint that the input set contains an unreadable file.)

### 7.5 The residual `.tsrx` hazard is **by design, not a defect**

Combine §7.1 and §7.2: because supplying a `.tsrx` file refuses the batch, the only workable
adoption path is to supply `.ts` files only. In that mode, every `.tsrx` caller is simply
absent, and `referencesOf` on a `.ts` helper will return `complete` listing only its `.ts`
callers. That is *correct* relative to the supplied set — the engine analyzes only its inputs,
which is documented and which is why every ground truth in this report is scoped to its input
set. But operationally, on a codebase that is 6,263 `.tsrx` files deep, "complete over the
files you gave me" and "complete" are very different claims, and only the receipt's `snapshot`
hash distinguishes them. This is a packaging/integration hazard for markless adoption, not an
honesty violation.

---

## 8. Score table

Wall times are 3-run medians of the full `node …/cli.js query <doc>` invocation and include
~48 ms of Node process startup (measured from the `q14` refusal path, which does almost no
work). Sizes are the receipt file in bytes.

| # | Query | Target / file | State | Found / GT | Missed+unnamed | Spurious | Wall (ms) | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q00a | resolveBinding | `isValidStorageKey` @ storage-key.ts | complete | 1/1 | 0 | 0 | 66 | 680 |
| q00b | resolveBinding | `serializeGraphValue` @ value.ts | complete | 1/1 | 0 | 0 | 64 | 672 |
| q00c | resolveBinding | `ASYNC_BOUNDARY_ARM` @ async-boundary-arm.ts | complete | 1/1 | 0 | 0 | 65 | 695 |
| q01 | referencesOf | `isValidStorageKey` | complete | 2/2 uses (2/5 occurrences) | **3** | 0 | 64 | 1,473 |
| q02 | referencesOf | `serializeGraphValue` | complete | 4/4 uses (4/6 occurrences) | **2** | 0 | 209 | 2,290 |
| q03 | referencesOf | `ASYNC_BOUNDARY_ARM` | complete | 4/4 uses (4/6 occurrences) | **2** | 0 | 78 | 2,029 |
| q04 | writesOf | `serializeGraphValue` | complete | 0/0 | 0 | 0 | 214 | 570 |
| q04b | writesOf | `ASYNC_BOUNDARY_ARM` | complete | 0/0 | 0 | 0 | 75 | 581 |
| q05 | exportedNames | storage-slot.ts | complete | 8/8 | 0 | 0 | 60 | 2,447 |
| q06 | resolveBinding | `encodeSlot` @ value.ts | complete | 1/1 | 0 | 0 | 61 | 654 |
| q06b | referencesOf | `encodeSlot` | complete | 7/7 | 0 | 0 | 210 | 3,452 |
| q07 | resolveBinding (scoped) | `records` @ encodeSlot | complete | 1/1 | 0 | 0 | 200 | 1,123 |
| q08 | referencesOf | `records` | complete | 24/24 | 0 | 0 | 229 | 10,217 |
| q09 | readsOf | `records` | complete | 24/24 | 0 | 0 (see §6.2) | 229 | 10,207 |
| q10 | **writesOf** | `records` | complete | **0/10 mutations** | **10** (17 incl. escapes) | 0 | 234 | 670 |
| q11 | resolveBinding (scoped) | `index` @ Map branch | complete | 1/1 | 0 | 0 | 204 | 1,300 |
| q12 | referencesOf | `index` | complete | 3/3 | 0 | 0 | 202 | 2,156 |
| q13 | writesOf | `index` | complete | 1/1 | 0 | 0 | 206 | 1,228 |
| q14 | exportedNames | `App.tsrx` (in set) | **refused** | n/a | n/a | n/a | 50 | 407 |
| q15 | exportedNames | `main.ts` (`.tsrx` in set) | **refused** | n/a | n/a | n/a | 49 | 407 |
| q16 | resolveBinding | `App` in `main.ts` (`.tsrx` in set) | **refused** | n/a | n/a | n/a | 49 | 407 |
| q17 | exportedNames | `main.ts` (`.tsrx` omitted) | **partial** | 0/0 + 3 named boundaries | 0 | 0 | 57 | 1,415 |
| q18 | resolveBinding | `App` in `main.ts` (`.tsrx` omitted) | **partial** | 1/1 + 3 named boundaries | 0 | 0 | 74 | 1,729 |
| q19 | resolveBinding | `App` w/ unparseable dependency | **partial** | 1/1 + 1 named site | 0 | 0 | 66 | 932 |
| q20 | resolveBinding | `fetchLocalUpdates` w/ unparseable dependent | complete | 1/1 | 0 | 0 | 69 | 644 |
| q21 | **referencesOf** | `fetchLocalUpdates` w/ unparseable dependent | **partial** | 1 use recovered + `unparsed-file` naming the caller | **0** | 0 | 63 | 2,649 |

**Aggregate over the three headline symbols (q01–q03), Set A:**
use-site recall 10/10 = **100%**; spurious 0; missed-and-unnamed **7** occurrences, all
import/re-export specifiers (D2).
**Across all 21 queries:** spurious sites **0**. Every `partial` receipt's `unresolved` list
genuinely accounted for its gaps. Every `complete` receipt was correct *except* where D1 or D2
applies.

### 8.1 Performance and size

Nothing here is a bottleneck. Median engine time (wall − 48 ms startup) is 12–186 ms for a
20-file / 3,648-LOC set; the heaviest query (`q08`, 24 sites) is ~181 ms. Receipts are small:
407 B (refusal) to 10.2 KB (24 results). Note the size driver is **anchors, not data** — a
24-site receipt is 10 KB because each site carries a 12-element `semanticPath` and a 64-char
hex fingerprint. That is ~425 B per site. A whole-repo query returning thousands of sites
would produce a multi-megabyte receipt, which is a real concern for agent context budgets.

### 8.2 Secondary observation: `site.fingerprint` is not a site identity

In every `referencesOf` receipt, **all** result sites share one fingerprint value:

| Receipt | results | distinct `site.fingerprint` |
| --- | --- | --- |
| `q08-refs-records` | 24 | **1** |
| `q06b-refs-encodeslot` | 7 | **1** |
| `q02-refs-serializegraphvalue` | 4 | **1** |
| `q03-refs-asyncboundaryarm` | 4 | **1** |
| `q12-refs-index` | 3 | **1** |

The field identifies the *target symbol*, not the site; sites are distinguished only by
`file` + `semanticPath`. Given the field is named `site.fingerprint` and sits inside the site
object, a consumer that de-duplicates results on it will collapse 24 sites to 1 and silently
lose 23. The engine's own `uniqueUnresolved` (`queries.ts:104`) is safe because it keys on
`reason:file:semanticPath:fingerprint`, but nothing in the receipt tells an external consumer
to do that. Rename or document.

---

## 9. Verdict

**Does the honesty contract hold on this real code? — Yes for the boundary, with two
substantive caveats inside the boundary.**

Where the contract is *about* uncertainty, it held without exception. Every situation in which
the engine could not see something, it said so and named the site: an unsupported language
refused the batch with a closed reason rather than guessing (§7.1); a missing module produced
`partial` with `unresolved-specifier` naming the exact import (§7.2); and — the test that
mattered most — **an unparseable caller produced `partial` with `unparsed-file` naming the
caller, not a confident `complete`** (§7.4). On a corpus with 6,263 files the engine cannot
read, that is the behaviour the whole product rests on, and it is correct. Add to that 100%
use-site recall and **zero spurious sites across all 21 queries**, correct traversal of a
two-hop import→re-export chain, correct handling of type-position references, and flawless
discrimination between four same-name `records` bindings and two same-name `index` bindings,
and the core engine is genuinely better than what it is competing against.

The caveats are not about uncertainty; they are about the engine answering a **narrower
question than its documentation promises, and stamping the narrow answer `complete`.**

- **D1 is the serious one.** `writesOf` is documented as "references that write **or may
  mutate**". On `records` — a binding mutated by ten `.push` calls and passed by reference
  seven more times — it returns `complete` with an empty result set and no `unresolved`
  entry. That is not a missing feature politely declined; it is a confident, integrity-signed
  "nobody mutates this" that is false. Until either the implementation covers mutation-through-
  reference or the query emits an `unresolved` reason for escaping bindings, `writesOf` should
  not be relied on for any mutation-safety question, and the README line should be corrected
  in the meantime.
- **D2 is smaller but has sharp edges.** `referencesOf` omits import specifiers and
  cross-module re-export specifiers — 7 occurrences across the three headline symbols — while
  reporting `complete`. Exclusion is a defensible definition, but it is undocumented and
  internally inconsistent: a local `export { X }` **is** returned while `export { X } from './y'`
  is not. Rename-style workflows built on `referencesOf` will produce broken code.

Both defects share one root shape and one fix: the engine currently treats "my definition of
the query" and "everything the caller could reasonably mean" as the same thing, and `complete`
asserts the latter. Publish the precise definition of *reference* and *write* in the receipt
contract, and where the narrow definition might not be what the caller meant, spend an
`unresolved` entry rather than a `complete`. That change is small, and it would move both
defects from the "silently wrong" column into the "honestly qualified" column where the rest
of this trial already sits.

**Adoption call for markless specifically:** usable today for navigation and read-side
questions (`resolveBinding`, `referencesOf`, `exportedNames`, `readsOf`) on `.ts` subsets, with
the caller responsible for pre-filtering `.tsrx` out of every input set and for understanding
that `complete` means complete-over-the-supplied-files. Not usable today for mutation analysis
or for automated renames.
