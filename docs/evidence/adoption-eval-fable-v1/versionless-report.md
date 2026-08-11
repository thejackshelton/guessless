# Guessless honesty trial against the versionless corpus — scored report

**Unit:** `adoption-eval-20260811/versionless-receipts`
**Date:** 2026-08-11
**Engine under test:** `packages/cli/dist/cli.js` (guessless 0.0.1), unmodified.
`sha256(cli.js) = 784899828ad9c45b0a5d3532ab29cea674832153fa2be187c74fd1e51f775439`,
`sha256(src-DWRHl3Qf.js) = 4a406b37aa6b3eb65c10d64a98f31011bf4adf30337343a0aade58fc931a7e85`.
Nothing was rebuilt.

**Corpus:** versionless fixture `react-boilerplate-v4`, i.e. `react-boilerplate/react-boilerplate`
@ `d19099afeff64ecfb09133c06c1cb18c0d40887e`. Extracted **read-only** from the versionless
cache archive into this evidence directory; archive digest verified against the fixture manifest:

```
$ cat /Users/jacksm5pro/dev/open-source/versionless/fixtures/react-boilerplate-v4/fixture.json | grep archiveSha256
    "archiveSha256": "d6ca60a3c8881ae2be26a8d04e00da4d922a6653f8512f2b12ac55d48f2ce2d5",
$ shasum -a 256 /Users/jacksm5pro/dev/open-source/versionless/.versionless/cache/react-boilerplate-v4/source.tar.gz
d6ca60a3c8881ae2be26a8d04e00da4d922a6653f8512f2b12ac55d48f2ce2d5  .../source.tar.gz
$ tar -xzf .../source.tar.gz -C docs/evidence/adoption-eval-fable-v1/raw-versionless/fixture
```

No file in `/Users/jacksm5pro/dev/open-source/versionless` was written.

**25 queries, 25 receipts, all verbatim in `raw-versionless/*.receipt.json`.** A further 35
receipts from the per-file parseability sweep are in `raw-versionless/parse-sweep/`.

---

## 1. Headline: three missed-and-unnamed defect classes, one of them new

Guessless's whole claim is the closed receipt: every site is either in `results`, or named in
`unresolved` with a reason from a closed enumeration, or the query is `refused`. A site that is
neither returned nor named is the one outcome the product says is impossible. This corpus
produced three, and the first one is not a replication — it is new, and it is the one that
matters most for legacy JavaScript.

### D1 (new, leads) — references arriving through a non-relative module specifier are dropped, and the referencing file contributes *nothing* to `unresolved`

react-boilerplate v4 resolves its own modules through webpack `resolve.modules: ['node_modules', 'app']`
(`internals/webpack/webpack.base.babel.js:118-122`). Half the codebase therefore imports its own
files as `containers/App/actions`, `utils/injectSaga`, `components/H2` — bare specifiers that are
*not* packages. This is not exotic; it is the dominant legacy React import style of that era.

Guessless classifies those specifiers as `external-module-boundary` ("Import 'containers/App/actions'
leaves the linked file set") **when it visits the importing file directly**. But when that file is a
bystander during a `referencesOf` traversal, the file is never linked, and so:

* its real reference sites are absent from `results`, **and**
* it produces **zero** entries in `unresolved` — the file name does not appear anywhere in the receipt.

Controlled A/B, same 35 inputs, same symbol, only the two module-specifier *strings* changed:

| query | inputs | `containers/HomePage/saga.js` in results? | in `unresolved`? | mentioned anywhere in receipt? |
|---|---|---|---|---|
| `q23-references-reposLoaded` (SET-A, verbatim fixture) | 35 | no | no | **no** |
| `q25-references-reposLoaded-relativised` (SET-E, `'containers/App/actions'` → `'../App/actions'`) | 35 | **yes** | yes | yes |

```
$ node -e '…' # raw-versionless/analyze.mjs
##### q23-references-reposLoaded partial
   R: containers/App/tests/actions.test.js …
   R: containers/App/tests/reducer.test.js …
   unresolved files: ["containers/App/tests/reducer.test.js","containers/HomePage/index.js",
                      "containers/HomePage/Loadable.js","containers/HomePage/tests/index.test.js"]
##### q25-references-reposLoaded-relativised partial
   R: containers/App/tests/actions.test.js …
   R: containers/App/tests/reducer.test.js …
   R: containers/HomePage/saga.js …
   R: containers/HomePage/tests/saga.test.js …
   unresolved files: [… ,"containers/HomePage/saga.js","containers/HomePage/tests/saga.test.js"]
```

The engine *can* name these boundaries — `q12-exportednames-homepage-saga` names all five of
saga.js's imports, including `containers/App/actions` and `containers/HomePage/selectors`, as
`external-module-boundary`. It simply does not name them when the file is a bystander. So this is
not the documented Yuku boundary being honestly reported; it is the same boundary being silently
skipped depending on traversal direction.

Concretely, for `LOAD_REPOS` (`q06`), the receipt says `partial` and its `unresolved` list is
dominated by `immer`, `react`, `reselect` and JSX parse diagnostics — while `containers/HomePage/saga.js:37`
(`yield takeLatest(LOAD_REPOS, getRepos)`) and `containers/HomePage/tests/saga.test.js:55` are simply
gone. An agent reading that receipt would conclude the action type is dispatched nowhere in the saga
layer. That is precisely the wrong answer a "fail-closed" tool is supposed to make impossible.

### D2 (replicates markless defect (b)) — `referencesOf` silently omits import specifiers

`containers/App/tests/actions.test.js` parses cleanly and contributes **zero** entries to
`unresolved` in `q02`. Its line 3 is:

```js
import { loadRepos, reposLoaded, repoLoadingError } from '../actions';
```

`'../actions'` resolves inside the input set (the engine proves it did, by returning the call site at
line 12 of the same file, bound to the same anchor). The `loadRepos` import specifier at line 3 is
therefore a resolved, in-set, parse-clean reference site. It appears in neither `results` nor
`unresolved`:

```
RESULTS in containers/App/tests/actions.test.js
   site:reference>…>CallExpression>Identifier>occurrence:0 read      # line 12 only
UNRESOLVED in containers/App/tests/actions.test.js
   (none)
--- any ImportSpecifier site anywhere in results? false
```

Across all six `referencesOf` receipts, **zero** results are `ImportSpecifier`/`ImportDefaultSpecifier`
sites; exactly one is an `ExportSpecifier` (`containers/HomePage/selectors.js:16`, in `q04`). So
export specifiers are modelled and import specifiers are not — the asymmetry is silent.

### D3 (replicates markless defect (a)) — `writesOf` misses mutation via method call

`internals/scripts/extract-intl.js`, SET-C (single file, verbatim):

```
21: let plugins = babel.plugins || [];
23: plugins.push('react-intl');
26: plugins = plugins.filter(p => p !== 'styled-components');
97:     const output = await transform(code, { filename, presets, plugins });
```

* `q15-writesOf-plugins` → **1 result**: the assignment at line 26. Nothing else.
* `q16-readsOf-plugins` → **3 results**: line 23 (the `plugins.push` receiver), line 26 RHS, line 97.

The engine therefore *sees* line 23 and classifies it `read`. The array mutation at that exact site is
neither a result of `writesOf` nor an `unresolved` entry — `q15`'s nine `unresolved` entries are all
import boundaries (`shelljs/global`, `fs`, `glob`, `@babel/core`, `lodash/get`, `./helpers/progress`,
`./helpers/checkmark`, `../../app/i18n`, `../../babel.config.js`). Ask "what writes `plugins`?" and you
are told "line 26", with a `partial` badge whose reasons are about unrelated imports.

Control that the query is not simply broken: `q18-writesOf-progress` on the same file returns exactly
the one real assignment (`progress = animateProgress(message)`, line 36) and correctly excludes the
bare declaration `let progress;` (line 34) and the read at line 43. `writesOf` works; it just models
assignment only.

### D4 (secondary, also unnamed) — `exportedNames` returns nothing for a CommonJS module

`app/i18n.js` is CommonJS *by design* — the file's own header says so ("must use CommonJS module
syntax; you CANNOT use import/export in this file"). It exports four names:

```
48: exports.appLocales = appLocales;
49: exports.formatTranslationMessages = formatTranslationMessages;
50: exports.translationMessages = translationMessages;
51: exports.DEFAULT_LOCALE = DEFAULT_LOCALE;
```

`q11-exportednames-i18n-cjs` → `state: partial`, `results: []`, and its five `unresolved` entries are
all `require()` boundaries. Zero parse diagnostics on that file (`parse-sweep.json` row `i18n.js`,
`parseDiagnostics: 0`). The engine models CJS `require` as imports — it names them — but reports no
exports and names no reason for their absence. Four exported names, missed and unnamed.

---

## 2. Method

### 2.1 Why this code cannot build (the claimed sweet spot)

| check | command | result |
|---|---|---|
| dependencies installed | `ls node_modules` (in fixture root) | `No such file or directory` |
| any resolvable dep | `node -e "require.resolve('react')"` | exit 1, `Error: Cannot find module 'react'` |
| TypeScript project | `ls tsconfig.json` | `No such file or directory` (no TS anywhere in the repo) |
| JSX lives in `.js` | `node --input-type=module -e "$(cat app/containers/HomePage/index.js)"` | `SyntaxError: Unexpected token '<'` at `<article>` |
| module resolution | `internals/webpack/webpack.base.babel.js:118` | `resolve: { modules: ['node_modules', 'app'], extensions: ['.js','.jsx','.react.js'] }` |
| runtime | `package.json` `engines.node >= 8.15.1`; fixture pins Node 16.20.2 | host is Node v24.15.0 |

Note that `node --check` is *not* a valid buildability probe here: on Node 24 it exits 0 on
module-syntax files containing JSX. The `--input-type=module -e` form above is the honest one.

10 of the 35 SET-A files carry JSX inside `.js` (`parse-sweep.json`, `hasJsx: true`), and all 10
produce `unparsed-file` diagnostics from the engine. So this is genuinely code that no
typechecker or bundler in this workspace can process without first `npm install`-ing a 2019
dependency tree under an EOL Node, and adding a JSX-aware parser configuration.

### 2.2 Input sets (the engine analyses only what is supplied)

| set | files | rooting | contents |
|---|---|---|---|
| **SET-A** | 35 | paths relative to `app/`, mirroring webpack's resolve root | the GitHub-repos redux data-flow subsystem, listed verbatim in `raw-versionless/inputset.json` |
| **SET-B** | 35 | same files, paths prefixed `app/` | rooting-sensitivity control |
| **SET-C** | 1 | `internals/scripts/extract-intl.js` | `writesOf`/`readsOf` mutation probes |
| **SET-D** | 1 | `internals/generators/language/index.js` | nested-scope `resolveBinding` probe |
| **SET-E** | 35 | SET-A with only the module-specifier *strings* in `saga.js` and `tests/saga.test.js` rewritten from webpack-alias to relative form | D1 A/B control |

SET-A file list (35): `app.js`, `configureStore.js`, `i18n.js`, `reducers.js`,
`components/ReposList/index.js`, `containers/App/{actions,constants,index,reducer,selectors}.js`,
`containers/App/tests/{actions,reducer,selectors}.test.js`,
`containers/HomePage/{Loadable,actions,constants,index,reducer,saga,selectors}.js`,
`containers/HomePage/tests/{actions,index,reducer,saga,selectors}.test.js`,
`containers/RepoListItem/index.js`,
`utils/{checkStore,constants,history,injectReducer,injectSaga,loadable,reducerInjectors,request,sagaInjectors}.js`.

Every query below states which set it ran against; the ground truth for each query was computed
over exactly that set and no other file.

### 2.3 Ground-truth procedure

Exhaustive whole-word search restricted to the input set, then every hit read in context and
classified by hand as declaration / import specifier / export specifier / value use / comment /
string literal:

```
$ cd raw-versionless/fixture/react-boilerplate-…/app
$ node -e 'console.log(require("../../../inputset.json").files.join("\n"))' > files.txt
$ cat files.txt | tr '\n' '\0' | xargs -0 grep -n -w loadRepos
$ cat files.txt | tr '\n' '\0' | xargs -0 grep -n -w makeSelectUsername
$ cat files.txt | tr '\n' '\0' | xargs -0 grep -n -w LOAD_REPOS
$ cat files.txt | tr '\n' '\0' | xargs -0 grep -n -w reposLoaded
```

`grep -w` does not match `LOAD_REPOS_SUCCESS`/`LOAD_REPOS_ERROR` (underscore is a word character),
so the constant's ground truth is not contaminated by its near-miss neighbours. Comment and
string-literal hits (`describe('loadRepos', …)`, `// Watches for LOAD_REPOS actions`) are listed
below and excluded from the site counts — the engine correctly returned **zero** of them, so it has
no spurious-site problem at all.

### 2.4 Harness

* `raw-versionless/run-queries.mjs` — builds each document, pipes it to `node packages/cli/dist/cli.js query -`,
  measures wall time with `process.hrtime.bigint()` around the child process, writes
  `<id>.request.json` + `<id>.receipt.json` verbatim and `timings.json`.
* `raw-versionless/parse-sweep.mjs` — one `exportedNames` query per SET-A file (35 receipts in
  `raw-versionless/parse-sweep/`, summary in `parse-sweep.json`).
* `raw-versionless/analyze.mjs` — receipt summariser used for the excerpts quoted here.

---

## 3. Symbol 1 — `loadRepos` (App action creator, `q01`/`q02`, SET-A)

Anchor (`q01`, `complete`, 638 B):
`containers/App/actions.js › module:scope:Program › symbol:loadRepos › declaration:FunctionDeclaration`.

| # | site (ground truth) | kind | in `results`? | named in `unresolved`? |
|---|---|---|---|---|
| — | `containers/App/actions.js:25` | declaration | no (by design; `definitionOf` covers it) | n/a |
| 1 | `containers/App/tests/actions.test.js:3` | import specifier | **no** | **no — file has 0 unresolved entries** |
| 2 | `containers/App/tests/actions.test.js:12` | call | yes | — |
| 3 | `containers/App/tests/reducer.test.js:4` | import specifier | **no** | **no** (file's only entry is `immer`) |
| 4 | `containers/App/tests/reducer.test.js:32` | call | yes | — |
| 5 | `containers/HomePage/index.js:30` | import specifier | **no** | no (file carries JSX parse diagnostics, none covering this site) |
| 6 | `containers/HomePage/index.js:125` | call | yes | — |
| 7 | `containers/HomePage/tests/index.test.js:13` | import specifier | **no** | no (file carries JSX parse diagnostics) |
| 8 | `containers/HomePage/tests/index.test.js:108` | call | yes | — |

**4 / 8 real sites returned. 0 spurious. 2 misses (#1, #3) are unnamed in the strong sense** — those
files parse cleanly and the receipt contains no reason that could account for them.

Excluded string/comment hits the engine correctly ignored: `actions.test.js:6`, `reducer.test.js:25`,
`tests/index.test.js:104`.

---

## 4. Symbol 2 — `makeSelectUsername` (selector; relative *and* webpack-alias importers, `q03`/`q04`, SET-A)

Anchor (`q03`, `partial`, 1 unresolved = `reselect`, 1 051 B):
`containers/HomePage/selectors.js › symbol:makeSelectUsername › declaration:VariableDeclarator`.

| # | site | kind | in `results`? | named? |
|---|---|---|---|---|
| — | `containers/HomePage/selectors.js:10` | declaration | no (by design) | n/a |
| 1 | `containers/HomePage/selectors.js:16` | **export specifier** | **yes** | — |
| 2 | `containers/HomePage/index.js:32` | import specifier (`'./selectors'`, in-set) | **no** | no |
| 3 | `containers/HomePage/index.js:115` | use, `createStructuredSelector` | yes | — |
| 4 | `containers/HomePage/saga.js:10` | import specifier (`'containers/HomePage/selectors'`, alias) | **no** | **no — saga.js absent from the whole receipt** |
| 5 | `containers/HomePage/saga.js:17` | **use** (`yield select(makeSelectUsername())`) | **no** | **no — D1** |
| 6 | `containers/HomePage/tests/selectors.test.js:1` | import specifier (`'../selectors'`, in-set) | **no** | **no — file has 0 unresolved entries** |
| 7 | `containers/HomePage/tests/selectors.test.js:16` | use | yes | — |

**3 / 7. 0 spurious.** Site #5 is the sharpest single failure in the trial: a plain value use of the
selector, in a file that is in the input set, that parses cleanly, missing with no reason given.
Site #1 proves export specifiers *are* modelled, which makes the import-specifier silence (#2, #4, #6)
a modelling gap rather than a deliberate exclusion of all specifier positions.

---

## 5. Symbol 3 — `LOAD_REPOS` (action-type constant, five import specifiers, `q05`/`q06`, SET-A)

Anchor (`q05`, `complete`, 643 B).

| # | site | kind | in `results`? | named? |
|---|---|---|---|---|
| — | `containers/App/constants.js:12` | declaration | no (by design) | n/a |
| 1 | `containers/App/actions.js:18` | import specifier | **no** | **no — 0 unresolved for this file** |
| 2 | `containers/App/actions.js:27` | use (`type: LOAD_REPOS`) | yes | — |
| 3 | `containers/App/reducer.js:11` | import specifier | **no** | **no** (only `immer` named) |
| 4 | `containers/App/reducer.js:27` | use (`case LOAD_REPOS:`) | yes | — |
| 5 | `containers/App/tests/actions.test.js:1` | import specifier | **no** | **no — 0 unresolved** |
| 6 | `containers/App/tests/actions.test.js:9` | use | yes | — |
| 7 | `containers/HomePage/saga.js:6` | import specifier (alias) | **no** | **no — D1** |
| 8 | `containers/HomePage/saga.js:37` | **use** (`takeLatest(LOAD_REPOS, getRepos)`) | **no** | **no — D1** |
| 9 | `containers/HomePage/tests/saga.test.js:7` | import specifier (alias) | **no** | **no — D1** |
| 10 | `containers/HomePage/tests/saga.test.js:55` | **use** | **no** | **no — D1** |

**3 / 10. 0 spurious.** Excluded comment/string hits correctly ignored: `actions.js:23`,
`saga.js:33`, `saga.test.js:53`.

`q19`/`q20` re-ran the same symbol over **SET-B** (identical files, every path prefixed `app/`):
identical 3 results, identical 57 unresolved. Rooting the document at the repo root instead of the
webpack root changes nothing — the alias blind spot is not a rooting mistake on my side, it is that
the engine has no notion of a resolve root other than relative specifiers.

---

## 6. Symbol 4 — `reposLoaded`, the D1 isolation (`q22`–`q25`)

Chosen because its four referencing files split cleanly 2 relative / 2 alias.

| # | site | kind | `q23` (SET-A) | `q25` (SET-E, specifiers relativised) |
|---|---|---|---|---|
| 1 | `containers/App/tests/actions.test.js:3` | import specifier | no / unnamed | no / unnamed |
| 2 | `containers/App/tests/actions.test.js:26` | use | **yes** | **yes** |
| 3 | `containers/App/tests/reducer.test.js:4` | import specifier | no / unnamed | no / unnamed |
| 4 | `containers/App/tests/reducer.test.js:48` | use | **yes** | **yes** |
| 5 | `containers/HomePage/saga.js:7` | import specifier | no / **unnamed** | no / file now named |
| 6 | `containers/HomePage/saga.js:23` | use | **no / unnamed** | **yes** |
| 7 | `containers/HomePage/tests/saga.test.js:8` | import specifier | no / **unnamed** | no / file now named |
| 8 | `containers/HomePage/tests/saga.test.js:40` | use | **no / unnamed** | **yes** |

**2 / 8 → 4 / 8** from changing nothing but two import strings. The residual 4 misses are all D2.

---

## 7. Reachability and `exportedNames`

### 7.1 `reachableFrom` from the saga entry point (`q07`/`q08`, SET-A) — clean pass

`q08-reachableFrom-getRepos` returned **11** symbols and named **9** boundaries. Ground truth for the
body of `getRepos` (`saga.js:15-27`): four locals (`username`, `requestURL`, `repos`, `err`) and seven
imported bindings actually used (`select`, `makeSelectUsername`, `call`, `request`, `put`,
`reposLoaded`, `repoLoadingError`) = **11**. Exact match, 0 misses, 0 spurious. Every one of saga.js's
five import boundaries is named with `site:reachability-import-boundary`, including the three webpack
aliases — further proof the engine can name them when it visits the file.

### 7.2 `reaches` (`q09`) — 0 results, all boundaries named

`state: partial`, `results: []`, 16 `unresolved` entries: eight `site:external-call-boundary`
("Invocation implementation from 'redux-saga/effects' is outside the linked set", ×4; from
`containers/App/actions` ×2; from `containers/HomePage/selectors` ×1) plus the eight import
boundaries. Every callee of `getRepos` genuinely lives outside the linked set, so an empty result with
each boundary enumerated is the correct fail-closed answer. Scored **pass**. (The receipt's own
`unresolved` entries are all sited *inside* `getRepos`'s body, which is the only evidence in the
receipt about which direction `reaches` traverses; the request schema does not say. That is a
documentation gap, not a dishonesty.)

### 7.3 `exportedNames`

| query | file | ground truth | returned | verdict |
|---|---|---|---|---|
| `q10` | `containers/App/selectors.js` (export list) | `selectGlobal`, `makeSelectCurrentUser`, `makeSelectLoading`, `makeSelectError`, `makeSelectRepos`, `makeSelectLocation` | all 6 | **exact** |
| `q12` | `containers/HomePage/saga.js` | `getRepos`, `default` | both | **exact** |
| `q11` | `i18n.js` (CommonJS) | `appLocales`, `formatTranslationMessages`, `translationMessages`, `DEFAULT_LOCALE` | **none** | **D4 — 4 missed, unnamed** |

The 35-file sweep (`parse-sweep.json`) adds two more misses, both of which **are** covered by named
`unparsed-file` diagnostics on the same file, and therefore count as honest partials rather than
defects:

* `containers/HomePage/Loadable.js` — ground truth `default`; returned none; 1 parse diagnostic named.
* `containers/RepoListItem/index.js` — ground truth `RepoListItem` + `default`; returned
  `RepoListItem` only; 2 parse diagnostics named.

Everything else in the sweep matched ground truth on spot-check, including three JSX-broken files
where error recovery still produced the right export list (`containers/HomePage/index.js` →
`default, HomePage, mapDispatchToProps`; `components/ReposList/index.js` → `default`;
`containers/App/index.js` → `default`).

### 7.4 `definitionOf` (`q13`) and nested-scope `resolveBinding` (`q21`)

`q13` returned exactly the declarator in `containers/HomePage/selectors.js` — correct.
`q21` asked for module-scope `actions` in `internals/generators/language/index.js`, where the only
`actions` binding lives inside a nested arrow function: `results: []`, `state: partial`, two
`builtin-module-boundary` entries. It invented nothing. Scored **pass**.

---

## 8. Replication verdicts

| markless defect | reproduces here? | evidence |
|---|---|---|
| **(a)** `writesOf` detects only assignments; mutation via method call returns silently | **Yes** | `q15` returns 1 write (line 26) and omits `plugins.push('react-intl')` at line 23; `q16` proves the engine sees line 23 and calls it a `read`; `q15`'s 9 unresolved entries are all unrelated import boundaries. Control `q18` shows plain assignments are found correctly. |
| **(b)** `referencesOf` silently omits import specifiers and cross-module re-export specifiers | **Yes** | 0 `ImportSpecifier`/`ImportDefaultSpecifier` results across all 6 `referencesOf` receipts; **all 16** distinct ground-truth import specifiers across the four symbols missed; at least **10** of them sit in files that contributed **zero** `unresolved` entries to the receipt that missed them. Export specifiers *are* returned (`q04`), so the omission is specifically the import side. |

One difference worth recording: on markless, defect (a) surfaced under a `complete` receipt. Here it
surfaces under a `partial` receipt whose stated reasons are all about `require()` boundaries. That is
arguably worse for a reader, because the `partial` badge invites them to believe the `unresolved` list
explains the gap.

---

## 9. Score table

| query | set | files | state | results | unresolved | ground truth | misses | unnamed misses | spurious | wall ms | bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `q01-resolve-loadRepos` | A | 35 | complete | 1 | — | 1 | 0 | 0 | 0 | 46.9 | 638 |
| `q02-references-loadRepos` | A | 35 | partial | 4 | 55 | 8 | 4 | **2** | 0 | 48.9 | 21 443 |
| `q03-resolve-makeSelectUsername` | A | 35 | partial | 1 | 1 | 1 | 0 | 0 | 0 | 36.9 | 1 051 |
| `q04-references-makeSelectUsername` | A | 35 | partial | 3 | 55 | 7 | 4 | **4** | 0 | 48.3 | 20 600 |
| `q05-resolve-LOAD_REPOS` | A | 35 | complete | 1 | — | 1 | 0 | 0 | 0 | 35.8 | 643 |
| `q06-references-LOAD_REPOS` | A | 35 | partial | 3 | 57 | 10 | 7 | **7** | 0 | 48.9 | 21 605 |
| `q07-resolve-getRepos` | A | 35 | partial | 1 | 9 | 1 | 0 | 0 | 0 | 39.2 | 4 038 |
| `q08-reachableFrom-getRepos` | A | 35 | partial | 11 | 9 | 11 | 0 | 0 | 0 | 43.3 | 12 694 |
| `q09-reaches-getRepos` | A | 35 | partial | 0 | 16 | 0 in-set | 0 | 0 | 0 | 47.2 | 7 881 |
| `q10-exportednames-app-selectors` | A | 35 | partial | 6 | 2 | 6 | 0 | 0 | 0 | 38.3 | 2 526 |
| `q11-exportednames-i18n-cjs` | A | 35 | partial | 0 | 5 | 4 | 4 | **4** | 0 | 38.3 | 2 213 |
| `q12-exportednames-homepage-saga` | A | 35 | partial | 2 | 9 | 2 | 0 | 0 | 0 | 39.4 | 4 187 |
| `q13-definitionOf-makeSelectUsername` | A | 35 | partial | 1 | 2 | 1 | 0 | 0 | 0 | 37.0 | 1 614 |
| `q14-resolve-plugins` | C | 1 | partial | 1 | 9 | 1 | 0 | 0 | 0 | 41.2 | 4 185 |
| `q15-writesOf-plugins` | C | 1 | partial | 1 | 9 | 2 | 1 | **1** | 0 | 90.1 | 4 400 |
| `q16-readsOf-plugins` | C | 1 | partial | 3 | 9 | 3 | 0 | 0 | 0 | 89.3 | 5 239 |
| `q17-resolve-progress` | C | 1 | partial | 1 | 9 | 1 | 0 | 0 | 0 | 39.8 | 4 187 |
| `q18-writesOf-progress` | C | 1 | partial | 1 | 9 | 1 | 0 | 0 | 0 | 90.8 | 4 487 |
| `q19-resolve-LOAD_REPOS-reporooted` | B | 35 | complete | 1 | — | 1 | 0 | 0 | 0 | 35.7 | 651 |
| `q20-references-LOAD_REPOS-reporooted` | B | 35 | partial | 3 | 57 | 10 | 7 | **7** | 0 | 47.8 | 21 849 |
| `q21-resolve-actions-array-nested` | D | 1 | partial | 0 | 2 | 0 at module scope | 0 | 0 | 0 | 35.4 | 1 181 |
| `q22-resolve-reposLoaded` | A | 35 | complete | 1 | — | 1 | 0 | 0 | 0 | 37.7 | 642 |
| `q23-references-reposLoaded` | A | 35 | partial | 2 | 55 | 8 | 6 | **6** | 0 | 50.4 | 20 655 |
| `q24-resolve-reposLoaded-relativised` | E | 35 | complete | 1 | — | 1 | 0 | 0 | 0 | 36.6 | 642 |
| `q25-references-reposLoaded-relativised` | E | 35 | partial | 4 | 62 | 8 | 4 | **4** | 0 | 49.6 | 24 218 |

Totals over the six `referencesOf` queries: **19 of 51** ground-truth reference sites returned,
**32 missed**, **30 of those 32 unnamed**, **0 spurious**.
`resolveBinding` (10 queries): 10/10 correct anchors, 0 inventions.
`reachableFrom` / `readsOf` / `definitionOf` / ESM `exportedNames`: exact on every ground truth checked.

### 9.1 Performance and receipt size

25 queries, 1 193 ms of wall time total (process spawn included). Min 35.4 ms, median 41.2 ms,
max 90.8 ms — the two `writesOf` calls and `readsOf` are the only ones above 60 ms. Receipts:
min 638 B, median 4.2 KB, max 24.2 KB. A 35-file `referencesOf` receipt costs ~21 KB, of which
roughly 95 % is the 55–62 `unresolved` entries; a symbol anchor is ~250 B. Nothing here is slow or
large enough to matter for an agent loop.

### 9.2 Secondary observation: `unresolved` volume is dominated by re-reported import boundaries

A single `referencesOf` receipt on 35 files carries 55–62 unresolved entries, but only 4–6 distinct
*files*, and entries repeat per specifier (`x4 redux-saga/effects`, `x3 containers/App/selectors`).
For a corpus with no `node_modules`, essentially every third-party import becomes an unresolved
entry, so the honest part of the receipt is also the noisy part. That is a real ergonomic cost of
running against unbuildable code, and it is what let D1 hide: a reader skims 55 boundary entries and
assumes the gaps are accounted for.

---

## 10. Sweet-spot check: did it answer on code that does not build?

**Yes, partially, and that partial-ness is the finding.**

The engine ran against 35 files of 2019 React with no dependencies installed, no `tsconfig`, JSX in
`.js`, and a webpack-only module resolution scheme, and it produced structured, symbol-anchored,
integrity-hashed answers in ~40 ms per query. It never crashed, never demanded a build, never
invented a site (0 spurious across all 25 queries), correctly resolved 10/10 anchors, and returned
exact answers for `reachableFrom`, `readsOf`, `definitionOf`, and ESM `exportedNames`. It named JSX
parse failures explicitly (`unparsed-file`, with the real Yuku diagnostic text) rather than pretending
the files were empty, and it still recovered correct export lists from three of the JSX-broken files.
No LSP or typechecker in this workspace can do any of that on this corpus today.

What an LSP/typechecker-based tool would have needed, stated factually and without running one:
`npm install` of the fixture's `package-lock.json` (a 2019 dependency tree, ~1 500 packages, pinned by
the fixture to Node 16.20.2 while this host runs Node 24.15.0); a JSX-capable parser configuration,
since the project keeps JSX in `.js` and relies on `babel-loader` with `internals/webpack` config; and
a resolver taught about `resolve.modules: ['node_modules', 'app']`, either through a `jsconfig.json`
`paths` mapping or a webpack-aware plugin, before any cross-file reference through
`containers/App/actions` would resolve. None of those exist in the fixture. Guessless needs none of
them to start answering — that part of the pitch holds.

But the same webpack-alias fact that breaks the LSP also breaks guessless's *contract*, and that is
the difference between the two failures. An LSP that cannot resolve `containers/App/actions` reports a
red squiggle: the user sees the failure. Guessless returns a well-formed `partial` receipt in which
the file containing the reference is not mentioned at all. The tool degrades from "correct" to
"confidently incomplete" rather than from "correct" to "visibly broken", and that is the failure mode
the receipt is supposed to prevent.

---

## 11. Verdict on the honesty contract for this corpus

`AGENTS.md` states the contract: *"Every query result must be `complete`, `partial` with every
unresolved site named, or `refused`… Never return a bare result list or silently omit an unclassified
site."* Against real react-boilerplate v4 code, **the contract does not hold**. Thirty of the fifty-one
ground-truth reference sites in this trial were omitted with no reason anywhere in the receipt, and
the omissions are not random: they follow three systematic rules — import specifiers are never
returned (D2), files reached only through non-relative specifiers are never visited *and never named*
(D1), and mutation through a method call is never a write (D3), with CommonJS exports invisible as a
fourth (D4). All four are silent. A caller cannot distinguish "this symbol has four uses" from "this
symbol has ten uses and I can only see four", because the receipt's `partial` badge is explained by
`immer` and `react`, not by the sites that are actually missing.

The parts of the contract that *do* hold are real and worth keeping: zero fabricated sites in 25
queries, closed and specific reasons where reasons are emitted (`external-module-boundary`,
`builtin-module-boundary`, `unresolved-specifier`, `unparsed-file`), refusal to guess a binding that
does not exist at the requested scope (`q21`), and honest surfacing of the JSX parse boundary instead
of silent truncation. The engine is not dishonest by construction; it is honest about exactly the
boundaries it has modelled, and this corpus contains four boundaries it has not modelled.

For an adoption decision the practical reading is: guessless's `resolveBinding`, `definitionOf`,
`reachableFrom`, `readsOf` and ESM `exportedNames` were trustworthy on unbuildable legacy code here,
and its `referencesOf` and `writesOf` were not — not because they were wrong, but because they were
wrong *quietly*. The cheapest thing that would change this verdict is not better resolution: it is
emitting an `unresolved` entry for every import specifier and every non-relative specifier the engine
declines to follow, so that a `partial` receipt names its own blind spots. On this corpus that single
change would have converted 30 unnamed misses into 30 named ones, and the contract would have held.
