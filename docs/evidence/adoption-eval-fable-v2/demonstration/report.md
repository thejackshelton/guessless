# Must-have demonstration — scope-resolved symbol truth at repo scale

**Verdict: PASS. No falsifier fired.**

`node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs` exits **0**:

```
verdict: PASS
  P1: pass
  P2: pass
  P3: pass
  P4: pass
  P5: pass
```

The engine's partition is clean where it answers (P1: zero decoy sites, zero over-returns), every
ground-truth site it does not return is named in the same receipt (P2), its serializer-scope answer
is byte-identical to the sealed v1/v2 ground truth (P3, F4 clear), grep provably cannot produce the
partition (P4), and the whole run takes 5.1 s on 635 files (P5).

This run supersedes the FALSIFIED run recorded here previously, in which falsifier F2 fired for both
target bindings: 19 real reference sites in 6 files vanished from the receipt entirely. Section 1
states the defect (D6), the repair, and its precision bounds; the honesty numbers are in section 2.

---

## 1. What was falsified before, and what changed

### The defect (D6)

`referencesOf` collects its gap set over the *dependents closure* of the declaring module
(`packages/engine/src/queries.ts`), plus `unlinkedInputSites` for supplied files outside that
closure. That second call is the intended repair for supplied inputs that never join the graph. But
`unlinkedInputSites` emitted **only** boundaries whose reason was `unlinked-input`, and
`boundaryReason` assigned that reason only when the failed specifier's path forms matched a supplied
input *path suffix*. The specifier `@markless/serializer` is not a path suffix of
`packages/serializer/src/index.ts`, so it was classified `external-module-boundary` — and
`unlinkedInputSites` dropped those. A file whose *only* link to the corpus was a workspace package
specifier was outside the dependents closure and outside the naming pass simultaneously: silent.

The gap was invisible in a 20-file serializer-scoped run (every file there links relatively) and
appeared only at repo scale, which is precisely what this demonstration was built to test. It cost
4 sites in 2 files for S1 and 15 sites in 4 files for S2 — `packages/web/src/fns/ssr.ts` (7 sites),
`packages/web/src/ssr-data/renderer.ts` (4), `packages/web/src/render-to-stream.ts` (2),
`packages/compiler/src/passes/render-data/index.ts` (2),
`packages/compiler/src/passes/public-render/shared.ts` (2),
`packages/compiler/src/passes/public-render/state-entries.ts` (2). All six are genuine sites:
`@markless/serializer` → `packages/serializer/package.json` exports `"."` → `src/index.ts` →
`export * from './value.ts'` → `export { deserializeGraphValue } from './value-decode.ts'`.

### The repair: name the strand, never guess the link

The supplied set carries a second kind of evidence besides file paths — its directory shape. A
package specifier (`@scope/name`, or bare `name`) whose **package-name tail** equals the last segment
of some supplied directory *may* denote files that were supplied. `boundaryReason` now returns a new
closed reason, **`unlinked-workspace-package`**, for exactly that case, and `unlinkedInputSites`
emits it alongside `unlinked-input` (`packages/engine/src/linking.ts`,
`packages/engine/src/contracts.ts`).

No edge is drawn. The supplied set contains no `package.json`, no `exports` map, no workspace globs
and no `main` field — nothing in it proves *which* supplied file is a package's entry point. Linking
`@markless/serializer` to `packages/serializer/src/index.ts` would be an inference from directory
convention, and a wrong link manufactures results, which is strictly worse than the silence it would
replace. So the engine names the strand and says why:

```
"reason": "unlinked-workspace-package",
"detail": "Import '@markless/serializer' did not resolve; its package name matches the supplied
           directory 'packages/serializer', so it may name supplied inputs — but no supplied
           manifest proves which supplied file is that package's entry point, so the link was
           named rather than guessed."
```

When the tail matches several supplied directories the detail lists them and says the match is
ambiguous, rather than picking one:

```
"Import '@markless/runtime' did not resolve; its package name matches 4 supplied directories
 ('packages/core/src/runtime', 'packages/router/src/vite/runtime',
  'packages/router/test/vite/runtime', 'packages/runtime'), so which one it denotes is ambiguous …"
```

`unlinked-input` (a match against a supplied **file path**) and `unlinked-workspace-package` (a match
against a supplied **directory**) stay separate reasons, so a receipt reader can tell the two
strengths of evidence apart without parsing details.

### Precision bounds, stated honestly

- **Sound direction (what the claim rests on):** every supplied file stranded behind a workspace
  package specifier is named. No supplied input reaching the corpus this way is silent.
- **Imprecise direction:** a genuinely external package whose name happens to equal a supplied
  directory's last segment is named too — a false *alarm*, never a false *result*. In this corpus
  that is 4 of the 13 distinct package names named: `@tsrx/core` and `@tsrx/typescript-plugin`
  (collide with `packages/core`, `packages/typescript-plugin`), `vite-plus` (collides with
  `packages/bundler/fixtures/vite-plus`) and `vite` (collides with `packages/bundler/src/vite`). The
  other 9 are the real `@markless/*` workspace packages.
- **Bounded:** a package whose name matches no supplied directory keeps `external-module-boundary`
  and adds no noise. In this corpus `pathe`, `ufo` and `@async/witness` do exactly that.
- **Never a link:** the mechanism has no linking path at all, ambiguous or not. Results are
  unchanged by the repair — 27 for S1 and 42 for S2, the same as in the falsified run.

Class regression tests: `packages/engine/test/linking.test.ts`, describe block *"workspace package
specifiers strand supplied inputs visibly"* — F2 reproduction on a multi-package fixture, subpath
specifiers, unscoped workspace names, an ambiguous tail matching two supplied roots, re-export
specifiers, reachability queries, the `unlinked-input`/`unlinked-workspace-package` split, and a
negative control proving a genuinely external package stays external and silent. The full gate is
green: 248 tests (239 before, 9 added), plus `pnpm build`, `pnpm typecheck` and `pnpm lint`.

---

## 2. The receipts

### P2 — no silent miss (the property that was falsified)

| | S1 `deserializeGraphValue` | S2 `ASYNC_BOUNDARY_ARM` |
| --- | --- | --- |
| Ground-truth target reference sites | 31 | 113 |
| Returned in `results` | 27 | 42 |
| Not returned | 4 | 71 |
| ...of those, **silent** (file absent from the receipt) | **0** | **0** |
| ...named by an entry quoting the *specifier the binding is reached through* | 4 | 71 |
| ...named only incidentally (an unrelated failing import in the same file) | 0 | 0 |

Every unreturned site is named under the strict reading, not merely the loose one: for all 75
unreturned sites the naming entry quotes the exact specifier the binding is reached through
(`'@markless/serializer'`, `'@markless/serializer/protocol'`,
`'@markless/serializer/async-boundary-arm'`). In the falsified run 19 sites were silent and a further
20 were named only incidentally.

The six previously-silent files, now named:

| File | Sites | Route | Named under |
| --- | --- | --- | --- |
| `packages/web/src/fns/ssr.ts` | 7 | `'@markless/serializer'` | `unlinked-workspace-package` |
| `packages/web/src/ssr-data/renderer.ts` | 4 | `'@markless/serializer'` | `unlinked-workspace-package` |
| `packages/web/src/render-to-stream.ts` | 2 | `'@markless/serializer'` | `unlinked-workspace-package` |
| `packages/compiler/src/passes/render-data/index.ts` | 2 | `'@markless/serializer/protocol'` | `unlinked-workspace-package` |
| `packages/compiler/src/passes/public-render/shared.ts` | 2 | `'@markless/serializer'` | `unlinked-workspace-package` |
| `packages/compiler/src/passes/public-render/state-entries.ts` | 2 | `'@markless/serializer'` | `unlinked-workspace-package` |

Receipt gap composition (both refs receipts name 391 of the 635 supplied files):

| Reason | S1 | S2 |
| --- | --- | --- |
| `unlinked-input` | 679 | 679 |
| `unlinked-workspace-package` | 551 | 551 |
| `builtin-module-boundary` | 44 | 3 |
| `external-module-boundary` | 26 | 1 |
| `unresolved-specifier` | 3 | 4 |
| `unresolved-symbol` | 1 | 3 |
| **total** | **1 304** | **1 241** |

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
| guessless names the rest | 4 of 4 ✔ | — | 71 of 71 ✔ | — |
| guessless silent | **0 ✔** | — | **0 ✔** | — |

### P3 / F4 — the sealed serializer-scope answer is unchanged under 21× input growth

The v1/v2 `q03` run supplied 20 serializer files; this run supplies 635. Inside
`packages/serializer/src/**` the S2 answer is **byte-identical** to the sealed v2 `q03` receipt:
the same 6 sites, same semantic paths, same fingerprints, same `access`, and the same target anchor
(`fingerprint 5afa208a…`) — matching the sealed v1 hand ground truth (occurrences 2-7 of the
7-occurrence table in `adoption-eval-fable-v1/markless-report.md` §5). The 4 results v1 returned are
a subset; the 2 import specifiers v1 missed are the ones D1/D2 added. F4 does not fire, and the D6
repair changed nothing inside this scope — it adds no results and removes none.

Coverage inside `packages/serializer/**` is 100 % for both symbols (22/22 and 16/16):
S1 — `value.ts` 1/1, `test/module-split` 2/2, `test/payload-scripts` 2/2, `test/protocol-state`
7/7, `test/serializer` 6/6, `test/value-correctness` 4/4.
S2 — `src/protocol.ts` 4/4, `src/protocol-validation.ts` 2/2, `test/module-split` 4/4,
`test/protocol.test.ts` 6/6.

### P5 — timings and receipt sizes

| Query | State | Results | Unresolved | Wall | Receipt |
| --- | --- | --- | --- | --- | --- |
| `S1-q00-resolve-deserializegraphvalue` | complete | 1 anchor | — | 164 ms | 690 B |
| `S1-q01-refs-deserializegraphvalue` | partial | 27 | 1 304 | 2 416 ms | 702 866 B |
| `S2-q00-resolve-async_boundary_arm` | complete | 1 anchor | — | 155 ms | 695 B |
| `S2-q01-refs-async_boundary_arm` | partial | 42 | 1 241 | 2 170 ms | 686 950 B |

Prepare (git-archive extract + read of 635 files / 5.38 MB): **144 ms**. Total prepare + queries:
**5 105 ms**, against a 600 000 ms budget — 0.9 % of it. Snapshot `ffc33304187d…` identical across
all four queries. Two consecutive runs produced **byte-identical** receipts, integrity hashes
included. The repair costs about 1.3 s of the total against the falsified run (3.8 s to 5.1 s) and
roughly doubles the refs receipts (378 KB to 703 KB, 361 KB to 687 KB), which is the price of naming
551 more boundaries per receipt.

---

## 3. Method

- **Corpus (read-only):** `/Users/jacksm5pro/dev/open-source/markless` at
  `931f054444a41c0527dfa77f812fa49e87df3b8f`. Sources are read from the commit via `git archive`
  into an OS temp dir, never from the working tree — so the checkout's pre-existing local
  modifications (15 entries, present before this unit started and untouched by it) cannot influence
  any answer, and nothing is written to the corpus.
- **Input set (mechanical):** `git ls-files '*.ts' | grep '^packages/'` → **635 files, 5 379 260
  bytes**, listed verbatim in `input-files.txt`. Committed files only; no untracked or `dist` trees.
  The set contains no `package.json`, which is why the D6 repair may not read manifests.
- **Anchors:** derived by the engine. Each symbol's anchor comes from a `resolveBinding` receipt
  (`*-q00-*`), whose single result is passed verbatim as the `referencesOf` target. No anchor was
  hand-authored.
- **Ground truth:** `build-ground-truth.mjs` enumerates every `\b<sym>\b` occurrence (file, line,
  column) mechanically and classifies it with a hand-audit map: for each file with a hit I read its
  imports/declarations and recorded the binding and the route to it. The script throws if a file
  with hits is unaudited, or if an audited file has no hit, so the audit cannot drift from the
  corpus. Declaration occurrences are marked `*-declaration` and are not counted as reference sites.
  The ground truth is unchanged from the falsified run — only the engine changed.
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
- **Engine build:** `pnpm build` from this worktree before the run; the CLI under test is
  `packages/cli/dist/cli.js` built from the sources on this branch.

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
pnpm build
node docs/evidence/adoption-eval-fable-v2/demonstration/run-demo.mjs
node docs/evidence/adoption-eval-fable-v2/demonstration/build-ground-truth.mjs
node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs   # exits 0
```

## 5. What the demonstration does and does not say

It **does** say: on 635 files in 5.1 s, the engine returned a scope-resolved partition that grep
cannot produce (0 of 5 decoy sites for S1, where 13.5 % of grep's answer is the wrong binding), never
over-returned a file, matched the hand audit exactly wherever it answered — including a two-hop
re-export chain and two type-position uses on one line — reproduced a sealed 21× smaller answer
byte-for-byte, and, the property this claim rests on, named every ground-truth site it did not
return, each one against the exact specifier that stranded it. Absence from `results` is not silence.

It does **not** say the engine returned everything. It returned 27 of 31 S1 sites and 42 of 113 S2
sites; the remaining 75 are named, not answered. A reader who needs those sites is told precisely
which files to look at and which unresolved specifier is in the way.

It does **not** say those specifiers were resolved. `unlinked-workspace-package` is a refusal with an
address, not a link: the engine can see that `@markless/serializer` probably means the supplied
`packages/serializer/` tree, and it declines to act on "probably". Supplying the workspace manifests,
or an input set whose imports are relative, is what turns those 75 named sites into answers — and
that is a change to the *inputs*, not a loosening of the engine.

It does **not** say the naming is precise in the other direction: 4 of the 13 package names it named
are genuinely external packages that collide with a supplied directory name (section 1). Those are
false alarms in a ledger, not false entries in an answer, and the detail on each one shows the reader
exactly what the match was made against.
