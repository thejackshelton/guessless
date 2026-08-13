# guessless

Guess less about JavaScript and TypeScript structure. Certify reference, mutation, and reachability claims with signed receipts: `complete` (the only state that licenses the word "all"), `partial` with every unresolved site named, or `refused`. `grep` finds; guessless certifies — it partitions same-name bindings grep can't and names exactly what it could not see.

```sh
echo '{"inputs":[{"path":"a.ts","source":"export const x = 1;"}],
      "request":{"kind":"exportedNames","file":"a.ts"}}' | npx guessless query -
```

`guessless query <envelope.json|->` answers; `guessless reproduce <bundle.json>` re-verifies any saved receipt byte-for-byte. Full docs, evidence, and agent-harness integration (docs block, skill, stop-hook claim gate, CI): [repository](https://github.com/compiled-run/guessless).

MIT
