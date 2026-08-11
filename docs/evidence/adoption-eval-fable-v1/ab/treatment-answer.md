# A/B treatment answer — markless serializer

Target package (read only): `/Users/jacksm5pro/dev/open-source/markless/packages/serializer`.
All `file:line` paths below are relative to that package root unless an absolute path is given.

Engine: `node packages/cli/dist/cli.js query <doc>` run from the guessless workspace root.
Every query was run against one snapshot containing all 20 `src/*.ts` files and all 8 `test/*.ts`
files of the package (snapshot `f898363d9d3a24e50acf381f9a28ad20664e2f44ab80a87cd6c0f396b53bfd84`).
Query documents and raw receipts are in `ab/treatment-scratch/`.

---

## Question 1

Rename `isValidStorageKey` -> `isAllowedStorageKey` across the serializer package (src and test).

### Sites that must change

| Site | What it is |
| --- | --- |
| `src/storage-key.ts:18` | The declaration: `export function isValidStorageKey(value: string): boolean`. Renaming here also renames the export of `src/storage-key.ts`. |
| `src/storage-slot.ts:1` | Re-export `export { isValidStorageKey } from './storage-key.ts';`. Both halves of the specifier are the same identifier, so this line carries the rename to the package's public surface. |
| `src/protocol-validation-storage.ts:8` | Named import specifier `import { isValidStorageKey } from './storage-key.ts';`. |
| `src/protocol-validation-storage.ts:45` | Call site `if (!isValidStorageKey(record.key))` inside `decodePayloadScripts`. |
| `src/storage-record-client.ts:3` | Named import specifier `import { isValidStorageKey } from './storage-key.ts';`. |
| `src/storage-record-client.ts:17` | Call site `!isValidStorageKey(entry.key) ||` inside `validateStorageRecords`. |

That is the complete set of binding-level occurrences of the identifier in `src/` and `test/`.

### Sites that must be reviewed (no identifier binding, but the rename changes their meaning)

| Site | What it is |
| --- | --- |
| `test/module-split.test.ts:153` | `expect(source).not.toMatch(/storage-key\|storage-record-client\|isValidStorageKey/);` — the name appears **inside a regex literal**, i.e. as text, not as a binding. No structural rename touches it, and it does not fail after the rename: it keeps passing while silently no longer guarding that `src/protocol-client.ts` stays free of the storage-key symbol. This is the highest-risk site in the plan. |
| `src/index.ts:6` | `export * from './storage-slot.ts';` — contains no textual occurrence of the name, but it is the reason `isValidStorageKey` is a public export of the package. Renaming is therefore a public API break, not an internal refactor. Decide whether to keep a compatibility alias. |
| `src/storage-key.ts:11-15` | Module header comment defining what a "valid" storage key is. It never names the function, so it is a wording-consistency review only ("valid" -> "allowed"), not a required edit. |

### Sites outside the serializer package (out of the stated rename scope, but affected)

| Site | What it is |
| --- | --- |
| `/Users/jacksm5pro/dev/open-source/markless/packages/web/test/module-split.test.ts:83` | The same regex-literal guard in another package. Same silent-weakening failure mode as `test/module-split.test.ts:153`. |
| `/Users/jacksm5pro/dev/open-source/markless/CHANGELOG.md:244` | Historical changelog entry naming the export. Review only; historical entries are normally left as written. |
| `packages/serializer/dist/index.js`, `dist/index.d.ts`, `dist/protocol-validation-storage-DBEF2IjR.js` | Build output containing the old name. Regenerate; never hand-edit. |

No other consumer in the markless monorepo imports the symbol.

**CLAIM: COMPLETE**

### Receipt states relied on

- `resolveBinding` (`src/storage-key.ts`, `isValidStorageKey`, space `value`, scope `null`) — state **complete**, 1 anchor, declaration `symbol:isValidStorageKey / declaration:FunctionDeclaration`.
- `definitionOf` on that anchor — state **complete**, 0 unresolved, definition in `src/storage-key.ts`.
- `referencesOf` on that anchor — state **partial**: 2 results (`src/protocol-validation-storage.ts` and `src/storage-record-client.ts`, both `access: "read"`), 16 unresolved sites. Every unresolved site is an import boundary in a test file with reason `external-module-boundary` (`vitest`) or `builtin-module-boundary` (`node:fs/promises`). None of those modules can export this symbol, so the partiality is inert for this question.
- `exportedNames` on `src/storage-slot.ts` — state **complete**; `isValidStorageKey` is listed.
- `exportedNames` on `src/index.ts` — state **complete**; `isValidStorageKey` is listed, which is how the public-API item above was established rather than guessed.

### How the answer was established

`referencesOf` located the two *call* sites with a bound-symbol guarantee, and `exportedNames`
(complete on both `storage-slot.ts` and `index.ts`) proved the re-export chain reaches the package
entry point. The receipt did **not** enumerate the three specifier lines (`storage-slot.ts:1`,
`protocol-validation-storage.ts:8`, `storage-record-client.ts:3`) — it reports references, not the
import/re-export bindings that must be rewritten alongside them — and by construction it cannot
report `test/module-split.test.ts:153`, because that occurrence is a regex literal rather than a
binding. I closed both gaps with an exhaustive case-insensitive text sweep (`grep -rni storagekey
src test`, 7 hits, all listed above) plus a check for indirect access paths: no `import * as` of
these modules, no computed member access such as `mod['isValidStorageKey']`, and no name built by
concatenation. The only dynamic import in the package is `src/value-decode-client.ts:17`
(`./value-decode-extensions.ts`), unrelated to storage keys. Receipt and text sweep agreed
everywhere they overlapped; the CLAIM rests on their union, with the receipt supplying binding
identity and the sweep supplying textual exhaustiveness.

---

## Question 2

Does `encodeSlot` in `src/value.ts` mutate its `records` parameter?

**Yes.** `records` is declared `records: SerializedRecord[]` (`src/value.ts:150`) and `encodeSlot`
pushes into it on every branch that materializes a record.

### Direct mutations of the `records` array

| Site | Mutation |
| --- | --- |
| `src/value.ts:176` | `records.push({ id, type: 'date', ... })` |
| `src/value.ts:185` | `records.push({ id, type: 'regexp', ... })` |
| `src/value.ts:194` | `records.push({ id, type: 'url', ... })` |
| `src/value.ts:204` | `records.push({ id, type: 'array-buffer', ... })` |
| `src/value.ts:219` | `records.push({ id, type: 'typed-array', ... })` |
| `src/value.ts:235` | `records.push({ id, type: 'data-view', ... })` |
| `src/value.ts:257` | `records.push(record)` (array record) |
| `src/value.ts:274` | `records.push(record)` (map record) |
| `src/value.ts:308` | `records.push(record)` (set record) |
| `src/value.ts:328` | `records.push(record)` (object record) |

### Mutations of state already reachable through `records`

Each of these pushes into a record object that was placed into `records` on the preceding line, so
they mutate the array's observable contents after insertion. They also cast away the `readonly`
declared on `SerializedRecord`, which is why a types-only reading of the signature understates the
mutation.

| Site | Mutation |
| --- | --- |
| `src/value.ts:258` | `(record.items as SerializedSlot[]).push(...)` — mutates the array record pushed at 257 |
| `src/value.ts:292` | `(record.entries as Array<readonly [SerializedSlot, SerializedSlot]>).push([...])` — mutates the map record pushed at 274 |
| `src/value.ts:312` | `(record.values as SerializedSlot[]).push(slot)` — mutates the set record pushed at 308 |
| `src/value.ts:333` | `(record.fields as Array<readonly [string, SerializedSlot]>).push([key, slot])` — mutates the object record pushed at 328 |

**CLAIM: COMPLETE** for the mutation-site list above (direct array mutations plus mutations of
records already inside the array).

### Propagation paths (not mutations themselves)

These pass the same array onward to callees that mutate it via the sites already listed; they are
listed for completeness of the "does it mutate" argument, not as additional mutation sites:
`src/value.ts:223` and `src/value.ts:238` (into `encodeArrayBufferViewBuffer`, which re-enters
`encodeSlot` at `src/value.ts:373`), and the recursive `encodeSlot` calls at `src/value.ts:261`,
`281`, `288`, `311`, `331`. `src/value.ts:373` is inside `encodeArrayBufferViewBuffer` and refers to
that function's own `records` parameter — a different binding that aliases the same array.

Reads only, not mutations: `records.length` at `src/value.ts:173, 183, 192, 202, 217, 233, 248`.

### Receipt states relied on

- `resolveBinding` (`src/value.ts`, `encodeSlot`, space `value`, scope `null`) — state **complete**, 1 anchor.
- `referencesOf` on `encodeSlot` — state **partial**, 7 results, 19 unresolved (all external/builtin import boundaries in test files). Used to obtain an in-body site anchor.
- `resolveBinding` (`src/value.ts`, `records`, space `value`, scope = an in-body site anchor of `encodeSlot`) — state **complete**, 1 anchor: `function:scope:Program>FunctionDeclaration:b77fe5d7...:0 / symbol:records / declaration:FunctionDeclaration`. With `scope: null` the same request returns state **complete** with **zero** results, because `records` has no module-scope binding; the scope anchor is required.
- `readsOf` and `referencesOf` on the `records` anchor — state **partial**, 24 results each, all labelled `access: "read"`, 19 unresolved (all external/builtin import boundaries in test files).
- `writesOf` on the `records` anchor — state **partial**, **0 results**, 19 unresolved.

### How the answer was established, and where the receipt and the code disagreed

`resolveBinding` pinned the exact parameter binding (complete), which rules out confusing it with the
same-named parameter of `encodeArrayBufferViewBuffer`. `referencesOf` then returned exactly 24
reference sites, which correspond one-for-one to the identifier occurrences at
`src/value.ts:173, 176, 183, 185, 192, 194, 202, 204, 217, 219, 223, 233, 235, 238, 248, 257, 261,
274, 281, 288, 308, 311, 328, 331`. That reference set is what makes the ten-item push list
defensible as exhaustive for the array itself: the engine enumerated every occurrence of the
binding, and I classified each by reading it.

The receipt and the code disagreed on one point, and I trusted the code. `writesOf` returned zero
results, which read literally would say `records` is never written or mutated. It is: ten
`records.push(...)` calls. The reason is that guessless classifies access at the *binding* level —
`records.push(...)` never rebinds `records`, so the identifier is a `read`, and the mutation happens
to the object the binding points at. The engine did not miss the sites; all ten appear in
`referencesOf`, labelled `read`. The operational lesson is that an empty `writesOf` must not be read
as "no mutation" for a parameter holding a mutable reference, despite the query's documented "or may
mutate" wording.

The second gap is coverage rather than labelling: `referencesOf` on `records` does **not** include
`src/value.ts:258, 292, 312, 333`, because those mutations reach the array through the local
`record` variable rather than through the `records` identifier. A rename-or-reference-driven review
would miss them entirely. I found them by reading `encodeSlot` end to end, and they matter precisely
because they mutate records *after* insertion and defeat the `readonly` field declarations on
`SerializedRecord`.
