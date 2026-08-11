# Guessless repository guidance

## Product constraints

- Build and prove the headless engine before adding the MCP server, then add the CLI only after the MCP adapter. Keep transport concerns out of the engine.
- Fail closed. Every query result must be `complete`, `partial` with every unresolved site named, or `refused` with a machine-readable reason. Never return a bare result list or silently omit an unclassified site.
- Preserve symbol-anchored citations, the closed unresolved-reason enumeration, and the JavaScript/TypeScript/JSX/TSX-only Yuku analysis boundary. Do not guess, add a second parser, or weaken receipt honesty for convenience.

## Utility conventions

- Prefer `magic-regexp` for regular expressions so patterns remain readable and composable.
- Prefer UnJS `pathe` for filesystem path handling so path behavior is portable across platforms.
- Prefer UnJS `ufo` for URL parsing, joining, normalization, and query-string handling.
- These utility preferences do not override the engine-first order or fail-closed receipt contract. Introduce or change dependencies only in a task that explicitly allows the relevant package manifest and lockfile edits.
