# @guessless/engine

Deterministic structural-analysis engine for JavaScript/TypeScript (JSX/TSX included) that returns integrity-protected receipts instead of bare result lists. Every answer is `complete`, `partial` with **every** unresolved site named under a closed reason enumeration, or `refused` — never a silent miss. Receipts bind request, snapshot, results, semantic anchors, and SHA-256 integrity; works on code that doesn't build (no tsconfig, no node_modules required).

Headless library; no transport concerns. See the [repository](https://github.com/thejackshelton/guessless) for the query surface, the MCP adapter (`@guessless/mcp`), and the `guessless` CLI.

MIT
