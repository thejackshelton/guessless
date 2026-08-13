<p align="center">
  <img src="site/guessless/uploads/pasted-1786572735264-0.png" alt="Guessless" width="180">
</p>

<h1 align="center">Guessless</h1>

<p align="center"><b>Grep tells you what it matched. Not what it missed.</b></p>

<p align="center">
  <a href="https://compiled.run/guessless">Docs</a> ·
  <a href="https://www.npmjs.com/package/guessless">npm</a> ·
  <a href="INTEGRATION.md">Agent integration</a> ·
  MIT
</p>

---

Say you're renaming a function across the whole codebase — or changing its signature, or deleting a
prop that half your components pass down. You search the project for the name, find 8 places that
use it, and update them. But there were 12, and a text search has no way to tell you that. The four
you missed look exactly like four that were never there, so the half-finished change ships and
nobody doubts it.

<table>
<tr>
<td width="50%" valign="middle"><img src="site/guessless/assets/mark-faint.png" width="44" align="left" hspace="10"><b>8</b><br>what a text search returned</td>
<td width="50%" valign="middle"><img src="site/guessless/assets/mark-glitch.png" width="44" align="left" hspace="10"><b>12</b><br>four of these were missed</td>
</tr>
</table>

Guessless reads JavaScript and TypeScript as structure rather than text, so it knows where every
name actually comes from — which import, which binding, which file. That is what makes a
codebase-wide transform safe to run: before you rewrite 200 call sites, you need to know the list
really is all 200. Every answer comes back as a **receipt** that says one of three things: this list
is complete, this list has gaps and here is each one, or I can't answer this safely.

## Install

```sh
npm install -D guessless        # CLI
npm install @guessless/engine   # library
npm install @guessless/mcp      # MCP server for agent harnesses
```

Also on `pnpm`, `yarn`, and `bun`. Requires Node.js 22+.

## 60 seconds

Ask which names a module exports and you get a receipt, not a list.

```sh
echo '{"inputs":[{"path":"api.ts","source":"export const answer = 42;\nexport function ask() { return answer; }"}],
      "request":{"kind":"exportedNames","file":"api.ts"}}' | npx guessless query -
```

```jsonc
{
  "schema": "guessless.receipt/v1",
  "state": "complete",                            // ← the load-bearing field
  "results": [{ "name": "answer" }, { "name": "ask" }],  // each carries a semantic anchor
  "snapshot": "18d4d322…",                        // hash of the exact inputs
  "integrity": "bf56322b…"                        // hash of this receipt
}
```

(Abridged — the real receipt also echoes the request and gives each result its full anchor.)

Three states, closed world:

| | State | Meaning | What it licenses |
| --- | --- | --- | --- |
| <img src="site/guessless/assets/mark-badge.png" width="34"> | `complete` | The result set is exhaustive | The word **"all"** |
| <img src="site/guessless/assets/mark-tilt.png" width="34"> | `partial` | Results **plus every unresolved site named**, with one of 20 machine-readable reasons | A qualified answer that knows its own gaps |
| <img src="site/guessless/assets/mark-hood.png" width="34"> | `refused` | Not answerable safely (e.g. unsupported language) | Nothing, and that's the point |

<details>
<summary>What <code>partial</code> and <code>refused</code> look like</summary>

A dynamic import built from an environment variable cannot be followed statically, so the gap is
reported with its reason instead of counted as absent:

```jsonc
{
  "schema": "guessless.receipt/v1",
  "state": "partial",
  "results": [{ "name": "load" }],
  "unresolved": [{
    "site": "import(process.env.PLUGIN)",
    "reason": "dynamic-specifier"
  }],
  "integrity": "9c01ee47…"
}
```

Python is not in the supported set, so the query is refused rather than answered with something the
engine cannot stand behind:

```jsonc
{
  "schema": "guessless.receipt/v1",
  "state": "refused",
  "reason": "unsupported-language",
  "integrity": "a377d208…"
}
```

</details>

Anyone can re-verify a saved receipt byte-for-byte: `guessless reproduce bundle.json`. Sites are
semantic anchors, not line numbers, so citations survive code moving.

## When you actually want this

**Transforms at scale.** In a 635-file / 161k-line trial, word-boundary grep for one symbol returned
96 hits of which 13 — 13.5% — were a *different* same-name binding, indistinguishable without
reading every file. Guessless returned zero of them, named the 4 sites it couldn't resolve by their
exact import specifier, and did it in ~5 seconds.

**Code that doesn't build.** No `node_modules`, no tsconfig, JSX-in-`.js`, webpack-era aliases:
where no language server can even start, Guessless answers and prices its uncertainty. Two imports
arriving through a webpack alias no analyzer can follow come back named by their exact specifier
rather than silently dropped. Re-exports are followed to their source, so `export *` hides nothing.

**Agent harnesses.** Don't hope the agent double-checks its own "renamed all 12 call sites" — gate
it with a ~20-line stop hook, and the claim is refused until a `complete` receipt for that exact
query exists. CI verifies it again on the way in. See [`INTEGRATION.md`](INTEGRATION.md) for the
four-layer setup: docs block, skill, claim gate, CI verification.

Grep is still the right search tool; this is not a search tool. Guessless exists for the one
sentence grep can't sign.

## Query surface

| Query | Answers | Returns |
| --- | --- | --- |
| `referencesOf(anchor)` | Every structural reference: uses and the import/re-export specifiers a rename must touch | `Receipt<Site[]>` |
| `writesOf(anchor)` | Proven writes. A call that may mutate is named as uncertain, never claimed or hidden | `Receipt<Site[]>` |
| `readsOf(anchor)` | Every read of the binding, with the same receipt semantics as `referencesOf` | `Receipt<Site[]>` |
| `definitionOf(anchor)` | The declaration site a binding resolves to, as a semantic anchor rather than a line number | `Receipt<Site>` |
| `exportedNames(file)` | The names a module exports. `export *` hides nothing; re-exports are followed to their source | `Receipt<Name[]>` |
| `capturesOf(anchor)` | The closures that capture a binding, so a move or inline knows what travels with it | `Receipt<Site[]>` |
| `resolveBinding(file, name, space)` | A binding by file, name, and space: the anchor every other query takes | `Receipt<Anchor>` |
| `reachableFrom(anchor)` | Transitive reachability outward from an entry point, with every boundary named | `Receipt<Site[]>` |
| `reaches(anchor)` | Transitive reachability inward: what can arrive at this binding, boundaries named | `Receipt<Site[]>` |

Strings and comments are never structural evidence (run one `rg` at the end for those). The full
semantics live in each receipt, not in prose.

## Library and MCP

```ts
import { GuesslessEngine } from "@guessless/engine";

const engine = new GuesslessEngine();
engine.addFile("api.ts", "export const answer = 42;");
engine.link();
const receipt = engine.referencesOf(engine.anchor("api.ts", "answer")!);
```

The MCP server (`npx -p @guessless/mcp guessless-mcp`) exposes snapshot preparation and safe-change
impact (rename / delete / entry-point) to any MCP harness, with summary and paged views for context
budgets — details in [`packages/mcp/README.md`](packages/mcp/README.md).

## How honest is it, really?

Everything above is measured, not estimated. When Guessless gets something wrong, that goes in the
docs next to what it got right.

- **It never pointed at the wrong place.** Every location it reported really was a use of that
  symbol. We checked all of them by hand against a list we had verified ourselves.
- **It never missed a place without saying so.** If it can't see somewhere, it names that gap in the
  receipt instead of quietly leaving it out. Getting there meant fixing six kinds of bug in August
  2026. One of our own tests caught a defect partway through, so we fixed it and re-ran that same
  test unchanged — and it passed.
- **Two things we have not proven yet.** Whether a coding agent actually writes better code when it
  gets these receipts, and whether the MCP server holds up inside real agent tools. Neither has been
  measured.

<img src="site/guessless/assets/mark-spark.png" width="26" align="left" hspace="8"> 51 real-repo queries, hand-audited: 202 places, 0 wrong places, 0 silent misses.

## Limitations

| | |
| --- | --- |
| **Languages** | `.js`, `.ts`, `.jsx`, `.tsx` only, via the Yuku analyzer. Anything else is `refused`, not guessed. |
| **Blind spots** | Structural analysis can't see strings, comments, or runtime dynamism. Those boundaries come back *named*. |
| **Scope** | A `complete` receipt is scoped to the exact snapshot it hashes. |

## License

MIT — [github.com/compiled-run/guessless](https://github.com/compiled-run/guessless)
