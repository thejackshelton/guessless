# Must-have demonstration — scope-resolved symbol truth at repo scale

**Verdict: FALSIFIED. Falsifier F2 fired, for both target bindings.**

`node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs` exits **1**:

```
verdict: FALSIFIED
  P1: pass
  P2: FAIL
  P3: pass
  P4: pass
  P5: pass
  F2 (S1): 4 ground-truth site(s) of 'deserializeGraphValue' are neither returned nor named
           anywhere in the receipt: packages/compiler/src/passes/public-render/shared.ts,
           packages/compiler/src/passes/public-render/state-entries.ts
  F2 (S2): 15 ground-truth site(s) of 'ASYNC_BOUNDARY_ARM' are neither returned nor named
           anywhere in the receipt: packages/compiler/src/passes/render-data/index.ts,
           packages/web/src/fns/ssr.ts, packages/web/src/render-to-stream.ts,
           packages/web/src/ssr-data/renderer.ts
```

The engine's partition is clean where it answers (P1: zero decoy sites, zero over-returns), its
serializer-scope answer is byte-identical to the sealed v1/v2 ground truth (P3, F4 clear), grep
provably cannot produce the partition (P4), and the whole run takes 3.8 s on 635 files (P5). But
the honesty contract — *absence from results is never silent* — does not hold at repo scale: 19
real reference sites in 6 files vanish from the receipt entirely.

---

## 1. The falsifying receipt

### F2 / S1 — `deserializeGraphValue`

Ground truth (hand audit, `ground-truth-S1.json`): 31 reference sites of the binding declared at
`packages/serializer/src/value-decode.ts:5`. The receipt
(`S1-q01-refs-deserializegraphvalue.receipt.json`, `state: "partial"`, 27 results, 845 unresolved
entries naming 273 files) returns 27 of them. The other 4:

| Site | Source line | In `results` | Named in `unresolved` |
| --- | --- | --- | --- |
| `packages/compiler/src/passes/public-render/shared.ts:2` | `import { deserializeGraphValue, type SerializedGraphPayload } from '@markless/serializer';` | no | **no** |
| `packages/compiler/src/passes/public-render/shared.ts:376` | `const value = deserializeGraphValue(cell.value as SerializedGraphPayload);` | no | **no** |
| `packages/compiler/src/passes/public-render/state-entries.ts:1` | `import { deserializeGraphValue } from '@markless/serializer';` | no | **no** |
| `packages/compiler/src/passes/public-render/state-entries.ts:16` | `: deserializeGraphValue(cell.value as SerializedGraphPayload);` | no | **no** |

Neither file appears anywhere in the 845-entry `unresolved` array — in fact **no**
`packages/compiler/src/**` file appears in it at all. Both are genuine sites of the target
binding: `@markless/serializer` → `packages/serializer/package.json` exports `"."` →
`src/index.ts` → `export * from './value.ts'` → `export { deserializeGraphValue } from
'./value-decode.ts'`.

### F2 / S2 — `ASYNC_BOUNDARY_ARM`

Ground truth: 113 reference sites of the constant declared at
`packages/serializer/src/async-boundary-arm.ts:7`. The receipt returns 42. Of the 71 missing:

| Class | Sites |
| --- | --- |
| Named by an unresolved entry that quotes the *specifier the binding is reached through* (`'@markless/serializer'`, `'@markless/serializer/async-boundary-arm'`) | 36 |
| Named only incidentally — the file appears in `unresolved`, but for a different failing import (`'vitest'`, `Module '../src/index.ts' has no export 'DomJournalEntry'`) | 20 |
| **Silent — file never appears in the receipt at all** | **15** |

The 15 silent sites, all reached through `@markless/serializer*`:

| File | Sites | Route |
| --- | --- | --- |
| `packages/web/src/fns/ssr.ts` | 7 (lines 23, 513, 515, 516, 811, 813, 814) | `'@markless/serializer'` → `src/index.ts` → `protocol.ts` |
| `packages/web/src/ssr-data/renderer.ts` | 4 (lines 2, 512, 513, 514) | same |
| `packages/web/src/render-to-stream.ts` | 2 (lines 2, 147) | same |
| `packages/compiler/src/passes/render-data/index.ts` | 2 (lines 1, 48) | `'@markless/serializer/protocol'` → `src/protocol.ts` |

P2 was scored on the *loose* reading (any unresolved entry naming the file counts). Under the
strict reading in the packet — "naming its file **and** failing specifier/reason" — 20 further S2
sites would also fail. F2 fires under either reading.

### Why it happens (mechanism, not speculation)

`referencesOf` collects its gap set over the *dependents closure* of the declaring module
(`packages/engine/src/queries.ts:1216-1225`), plus `unlinkedInputSites` for supplied files outside
that closure. That second call is exactly the intended repair — its comment reads "A supplied input
whose specifiers failed to link never enters the dependents closure, so its reference sites are
invisible to the walk above. Name every such file: absence from results must never be silent." But
`unlinkedInputSites` (`packages/engine/src/linking.ts:113-141`) emits **only** boundaries whose
reason is `unlinked-input`, and `boundaryReason` (`linking.ts:89-92`) assigns that reason only when
the specifier's path forms match a supplied input path suffix (`namesSuppliedInput`). The specifier
`@markless/serializer` normalises to `markless/serializer`, which is not a path suffix of
`packages/serializer/src/index.ts`, so it is classified `external-module-boundary` — and
`unlinkedInputSites` drops those. A file whose *only* link to the corpus is a bare package
specifier is therefore outside the closure and outside the naming pass simultaneously: silent.

The gap is invisible in a 20-file serializer-scoped run (every file there links relatively) and
appears only at repo scale, which is precisely what this demonstration was built to test.

---

## 2. What did hold

### P1 — zero decoy sites (partition is clean where the engine answers)

| Symbol | grep (`\b<sym>\b`) | of those, decoy | guessless `results` | decoy sites returned | over-returns |
| --- | --- | --- | --- | --- | --- |
| S1 `deserializeGraphValue` | 37 hit lines / 37 occurrences | **5** | 27 | **0** | 0 |
| S2 `ASYNC_BOUNDARY_ARM` | 112 hit lines / 114 occurrences | 0 | 42 | **0** | 0 |

Per-file counts match the hand audit exactly wherever the engine answered — no file received more
sites than it has occurrences of the name, and no file received a site of the wrong binding.

### P4 — grep provably cannot produce the partition (S1)

`packages/web/src/payload-graph-construct.ts:148` declares its own module-local
`async function deserializeGraphValue`, which lazily imports `deserializeGraphValueForClient` from
`../../serializer/src/value-decode-client.ts` — a different function, in a different module, with a
different signature. Its 4 call sites (lines 68, 134, 137, 139) plus its declaration are 5 of
grep's 37 hits, i.e. **13.5 % of grep's answer for S1 is the wrong binding**, and nothing textual
distinguishes them. grep's answer is the undifferentiated union `{31 target sites, 5 decoy sites,
1 declaration}`; the engine returned 27 target sites and 0 decoy sites.

### Per-symbol partition table, grep vs guessless

| | S1 target | S1 decoy | S2 target | S2 decoy |
| --- | --- | --- | --- | --- |
| Ground truth (reference sites) | 31 | 5 | 113 | 0 |
| grep returns | 31 ✔ | 5 ✘ (cannot exclude) | 113 ✔ | 0 |
| guessless `results` | 27 | **0 ✔** | 42 | **0 ✔** |
| guessless names the rest | 0 of 4 missing | — | 56 of 71 missing | — |
| guessless silent | **4 ✘ (F2)** | — | **15 ✘ (F2)** | — |

### P3 / F4 — the sealed serializer-scope answer is unchanged under 21× input growth

The v1/v2 `q03` run supplied 20 serializer files; this run supplies 635. Inside
`packages/serializer/src/**` the S2 answer is **byte-identical** to the sealed v2 `q03` receipt:
the same 6 sites, same semantic paths, same fingerprints, same `access`, and the same target anchor
(`fingerprint 5afa208a…`) — matching the sealed v1 hand ground truth (occurrences 2-7 of the
7-occurrence table in `adoption-eval-fable-v1/markless-report.md` §5). The 4 results v1 returned are
a subset; the 2 import specifiers v1 missed are the ones D1/D2 added. F4 does not fire.

Coverage inside `packages/serializer/**` is 100 % for both symbols:
S1 — `value.ts` 1/1, `test/module-split` 2/2, `test/payload-scripts` 2/2, `test/protocol-state`
7/7, `test/serializer` 6/6, `test/value-correctness` 4/4.
S2 — `src/protocol.ts` 4/4, `src/protocol-validation.ts` 2/2, `test/module-split` 4/4,
`test/protocol.test.ts` 6/6.

### P5 — timings and receipt sizes

| Query | State | Results | Unresolved | Wall | Receipt |
| --- | --- | --- | --- | --- | --- |
| `S1-q00-resolve-deserializegraphvalue` | complete | 1 anchor | — | 157 ms | 690 B |
| `S1-q01-refs-deserializegraphvalue` | partial | 27 | 845 | 1 800 ms | 378 422 B |
| `S2-q00-resolve-async_boundary_arm` | complete | 1 anchor | — | 152 ms | 695 B |
| `S2-q01-refs-async_boundary_arm` | partial | 42 | 778 | 1 499 ms | 360 984 B |

Prepare (git-archive extract + read of 635 files / 5.38 MB): **151 ms**. Total prepare + queries:
**3 813 ms**, against a 600 000 ms budget — 0.6 % of it. Snapshot `ffc33304187d…` identical across
all four queries. Two consecutive runs produced identical result/unresolved counts.

---

## 3. Method

- **Corpus (read-only):** `/Users/jacksm5pro/dev/open-source/markless` at
  `931f054444a41c0527dfa77f812fa49e87df3b8f`. Sources are read from the commit via `git archive`
  into an OS temp dir, never from the working tree — so the checkout's pre-existing local
  modifications (15 entries, present before this unit started and untouched by it) cannot influence
  any answer, and nothing is written to the corpus.
- **Input set (mechanical):** `git ls-files '*.ts' | grep '^packages/'` → **635 files, 5 379 260
  bytes**, listed verbatim in `input-files.txt`. Committed files only; no untracked or `dist` trees.
- **Anchors:** derived by the engine. Each symbol's anchor comes from a `resolveBinding` receipt
  (`*-q00-*`), whose single result is passed verbatim as the `referencesOf` target. No anchor was
  hand-authored.
- **Ground truth:** `build-ground-truth.mjs` enumerates every `\b<sym>\b` occurrence (file, line,
  column) mechanically and classifies it with a hand-audit map: for each file with a hit I read its
  imports/declarations and recorded the binding and the route to it. The script throws if a file
  with hits is unaudited, or if an audited file has no hit, so the audit cannot drift from the
  corpus. Declaration occurrences are marked `*-declaration` and are not counted as reference sites.
- **Baseline:** this machine has no ripgrep binary on `PATH` (`rg` is a shell function), so the
  baseline was taken with `grep -rnw '<sym>' packages`, which is exactly ripgrep's `\b<sym>\b`
  word-boundary match. The two were compared directly on this corpus for both symbols: after
  sorting, the hit lists are byte-identical (37 lines S1, 112 lines S2). Verbatim hit lists are
  checked in as `baseline-S1.txt` / `baseline-S2.txt`.
- **Scoring granularity:** engine anchors carry semantic paths, not line numbers, so results are
  compared per file by occurrence count. This is exact for these two symbols: every file that
  mentions either name has exactly one binding of that name in scope (the only declaring files are
  `value-decode.ts` and `payload-graph-construct.ts` for S1, `async-boundary-arm.ts` for S2), so
  "n occurrences in file F" and "n sites of that binding in F" are the same set.

## 4. Files

| File | What |
| --- | --- |
| `run-demo.mjs` | builds the 635-file input set from the commit, runs resolve + refs per symbol |
| `build-ground-truth.mjs` | mechanical occurrence enumeration + hand-audit classification, baseline capture |
| `score-demo.mjs` | P1-P5 / F1-F5, writes `scores.json`, exits non-zero unless all pass |
| `ground-truth-S1.json`, `ground-truth-S2.json` | per-site ground truth with binding, route and evidence |
| `baseline-S1.txt`, `baseline-S2.txt` | verbatim word-boundary grep hit lists |
| `S1-q00-*`, `S1-q01-*`, `S2-q00-*`, `S2-q01-*` `.receipt.json` | engine receipts |
| `query-index.json`, `timings.json`, `input-files.txt` | requests, snapshots, timings, input set |
| `scores.json` | full machine-readable scoring, including every missed file |

Reproduce:

```sh
node docs/evidence/adoption-eval-fable-v2/demonstration/run-demo.mjs
node docs/evidence/adoption-eval-fable-v2/demonstration/build-ground-truth.mjs
node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs   # exits 1 while F2 stands
```

## 5. What the falsification does and does not say

It does **not** show a wrong answer: no decoy site was ever returned, no site was returned twice,
and the scope-resolved partition matched the hand audit exactly wherever the engine answered,
including a two-hop re-export chain and two type-position uses on one line. It does **not** show
the sealed results were unstable — the serializer-scope answer survived a 21× larger input set
byte-for-byte. It does **not** show a performance problem — 635 files in 3.8 s.

It shows the **completeness ledger is incomplete at repo scale**: when a supplied file reaches the
target binding only through a bare package specifier, it is both outside the dependents closure and
outside the `unlinked-input` naming pass, so it disappears without a trace. A reader of the receipt
cannot tell that `packages/web/src/fns/ssr.ts` has 7 sites of the symbol they asked about. That is
the property the must-have claim rests on, so the claim is disproved as specified until those files
are named.
