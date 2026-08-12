# guessless

> 🧾 Grep finds. Guessless certifies.

[![npm](https://img.shields.io/npm/v/guessless)](https://www.npmjs.com/package/guessless)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

When a coding agent greps for call sites and finds 8 of 12, the 4 it missed look exactly like 4 that don't exist — and the rename ships broken with full confidence. Guessless is a structural-analysis engine for JavaScript and TypeScript that makes that impossible to do silently: every answer is a signed **receipt** that is either *exhaustive*, *explicitly incomplete with every gap named*, or *refused*. It's the missing typechecker for the sentence "I found all of them."

## 📦 Install

```sh
npm install -D guessless        # CLI
npm install @guessless/engine   # library
npm install @guessless/mcp      # MCP server for agent harnesses
```

Requires Node.js 22+.

## ⚡ 60 seconds

Ask which names a module exports:

```sh
echo '{"inputs":[{"path":"api.ts","source":"export const answer = 42;"}],
      "request":{"kind":"exportedNames","file":"api.ts"}}' | npx guessless query -
```

You get a receipt, not a list:

```jsonc
{
  "schema": "guessless.receipt/v1",
  "state": "complete",              // ← the load-bearing field
  "results": [{ "name": "answer", "module": { /* semantic anchor */ } }],
  "snapshot": "18d4d322…",          // hash of the exact inputs
  "integrity": "bf56322b…"          // hash of this receipt
}
```

Three states, closed world:

| State | Meaning | What it licenses |
| --- | --- | --- |
| ✅ `complete` | The result set is exhaustive | The word **"all"** |
| 🟡 `partial` | Results **plus every unresolved site named**, with one of 20 machine-readable reasons | A qualified answer that knows its own gaps |
| ⛔ `refused` | Not answerable safely (e.g. unsupported language) | Nothing — and that's the point |

Anyone can re-verify a saved receipt byte-for-byte: `guessless reproduce bundle.json`. Sites are semantic anchors, not line numbers, so citations survive code moving.

## 🎯 When you actually want this

- **Renames and deletions at scale.** In a 635-file / 161k-line trial, word-boundary grep for one symbol returned an answer where 13.5% of hits were a *different* same-name binding — indistinguishable without reading every file. Guessless returned zero of them, named every site it couldn't resolve by its exact import specifier, and did it in ~5 seconds.
- **Code that doesn't build.** No `node_modules`, no tsconfig, JSX-in-`.js`, webpack-era aliases — where no LSP can even start, guessless answers and prices its uncertainty.
- **Agent harnesses.** Don't hope the agent double-checks — gate it: a ~20-line stop-hook refuses to accept "renamed all call sites" without a receipt attached. See [`INTEGRATION.md`](INTEGRATION.md) for the four-layer setup (docs block, skill, claim gate, CI verification).

Grep is still the right search tool — this is not a search tool. Guessless exists for the one sentence grep can't sign.

## 🔍 Query surface

| Query | Answers |
| --- | --- |
| `referencesOf` | Every structural reference — uses **and** the import/re-export specifiers a rename must touch |
| `writesOf` | Proven writes; a call that *may* mutate (`x.push(…)`, `mutate(x)`) is **named as uncertain**, never claimed or hidden |
| `readsOf` / `definitionOf` / `exportedNames` / `capturesOf` | What they say on the tin, receipt semantics included |
| `resolveBinding` | A binding by file, name, and space — the anchor every other query takes |
| `reachableFrom` / `reaches` | Transitive reachability, boundaries named |

Strings and comments are never structural evidence (run one `rg` at the end for those). `export *` hides nothing. The full semantics live in each receipt, not in prose.

## 🔌 Library and MCP

```ts
import { GuesslessEngine } from "@guessless/engine";

const engine = new GuesslessEngine();
engine.addFile("api.ts", "export const answer = 42;");
engine.link();
const receipt = engine.referencesOf(engine.anchor("api.ts", "answer")!);
```

The MCP server (`npx -p @guessless/mcp guessless-mcp`) exposes snapshot preparation and safe-change impact (rename / delete / entry-point) to any MCP harness, with summary and paged views for context budgets — details in [`packages/mcp/README.md`](packages/mcp/README.md).

## 🧾 How honest is it, really?

The claims above are measured, not aspirational — and the misses are published alongside the hits:

- **Zero spurious sites** across every trial ever run against hand-audited ground truth (202 sites over 51 real-repo queries, plus a 144-site repo-scale demonstration).
- **Zero missed-and-unnamed sites** after a six-defect-class fix campaign in 2026-08 — a class of failure this project treats as its most severe defect, hunted with adversarial fixtures and preregistered falsifiers. One falsifier genuinely fired mid-campaign; the defect was fixed and the identical protocol then passed.
- **What's honestly unproven**: that an agent *in the loop* gets more correct with receipts (small-repo trials showed a tie at higher cost — the value case is scale and unbuildable code), and MCP transport under real agent clients. Raw evidence bundles are kept in a local archive; ask if you want them.

## ⚠️ Limitations

JS/TS/JSX/TSX only, via the Yuku analyzer — anything else is `refused`, not guessed. Structural analysis can't see strings, comments, or runtime dynamism; those boundaries come back *named*, and a `complete` receipt is scoped to the exact snapshot it hashes.

## 📄 License

MIT
