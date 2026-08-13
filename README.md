<p align="center">
  <img src="site/guessless/uploads/pasted-1786572735264-0.png" alt="Guessless" width="150">
</p>

<h1 align="center">Guessless</h1>

<p align="center"><b>Grep tells you what it matched. Not what it missed.</b></p>

<p align="center">
  <a href="https://compiled.run/guessless"><b>Docs</b></a> ·
  <a href="https://www.npmjs.com/package/guessless">npm</a> ·
  <a href="INTEGRATION.md">Agent integration</a>
</p>

---

Rename a function and grep finds 8 call sites. There were 12. The four you missed look exactly like
four that were never there, so the half-finished change ships and nobody doubts it.

Guessless reads JavaScript and TypeScript as structure rather than text, so it knows where every
name actually comes from. Every answer is a **receipt** in one of three states:

| | State | Meaning |
| :-: | --- | --- |
| <img src="site/guessless/assets/mark-badge.png" width="30"> | `complete` | The list is exhaustive — you may say **"all"** |
| <img src="site/guessless/assets/mark-tilt.png" width="30"> | `partial` | Results **plus every gap named**, with a machine-readable reason |
| <img src="site/guessless/assets/mark-hood.png" width="30"> | `refused` | Not answerable safely, and that's the point |

## Install

```sh
npm install -D guessless        # CLI
npm install @guessless/engine   # library
npm install @guessless/mcp      # MCP server
```

Requires Node.js 22+.

## Use it

```sh
echo '{"inputs":[{"path":"api.ts","source":"export const answer = 42;"}],
      "request":{"kind":"exportedNames","file":"api.ts"}}' | npx guessless query -
```

```jsonc
{
  "schema": "guessless.receipt/v1",
  "state": "complete",        // ← the load-bearing field
  "results": [{ "name": "answer" }],
  "integrity": "bf56322b…"    // re-verify later: guessless reproduce bundle.json
}
```

Nine queries: references, writes, reads, definitions, exports, captures, and reachability in both
directions. **[Full query surface →](https://compiled.run/guessless)**

## Where it earns its keep

Codebase-wide transforms, and code no language server can load — no `node_modules`, no tsconfig,
JSX-in-`.js`, webpack-era aliases. Where an analyzer can't start, Guessless answers and prices its
uncertainty instead of guessing.

For agents: gate the "renamed all 12 call sites" claim behind a `complete` receipt rather than
hoping. See [`INTEGRATION.md`](INTEGRATION.md).

Grep is still the right search tool. This is not a search tool.

## Limitations

`.js` `.ts` `.jsx` `.tsx` only — anything else is `refused`, not guessed. Structural analysis can't
see strings, comments, or runtime dynamism; those boundaries come back *named*. A `complete` receipt
is scoped to the exact snapshot it hashes.

Measured, with the misses published next to the hits — including
[what isn't proven yet](https://compiled.run/guessless).

---

MIT — [compiled.run/guessless](https://compiled.run/guessless)
