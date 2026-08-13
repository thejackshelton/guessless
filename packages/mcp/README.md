# @guessless/mcp

MCP stdio server exposing [guessless](https://github.com/compiled-run/guessless) structural receipts to agent harnesses: snapshot preparation, safe-change impact (rename / delete / entry-point), and the nine structural queries, with summary and paged views for context budgets. Each tool returns the engine receipt unchanged — `complete`, `partial` with named gaps, or `refused`.

```sh
npx -p @guessless/mcp guessless-mcp
```

MIT
