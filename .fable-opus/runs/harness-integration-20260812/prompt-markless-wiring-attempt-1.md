Fable-Opus-Unit: harness-integration-20260812/markless-wiring

## Goal

Wire the guessless integration into the markless repository at /Users/jacksm5pro/dev/open-source/markless. Working directory is the guessless workspace; the canonical copy-paste blocks are in `docs/integration.md` (T001's output — read it first and use its blocks, adapted only where this packet says).

Four edits, all additive, NO commits or pushes in markless (changes stay in the working tree for owner review):

1. **`AGENTS.md`** — append a marked section (`## Guessless structural receipts` with an HTML comment `<!-- guessless-integration:begin/end -->`) from the integration guide's AGENTS.md block: JS/TS completeness claims require a guessless receipt; the CLI invocation; receipt states and what each permits. Append-only — do not touch existing content.
2. **`CLAUDE.md`** — same marked section, same append-only rule.
3. **`.claude/skills/guessless/SKILL.md`** — the guide's skill block with valid frontmatter (name, description with trigger conditions: renaming, deleting, or enumerating references/reachability in JS/TS). Add a markless-specific note: `.tsrx` sources are refused by design — the skill applies to the `.ts` toolchain code (compiler, serializer, router, web packages).
4. **`.claude/settings.json`** — EXISTS ALREADY. Read it first; produce an additive merge that preserves every existing key and array entry exactly, adding the Stop hook entry invoking `node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs`. If a `hooks.Stop` array exists, append to it; never replace. Validate JSON after. If the existing file has conflicting Stop hooks that could interact badly with the gate, note it in the receipt rather than removing them.

Then a functional check (read-only beyond your four files): run `node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs --check` against two temp claim files (one bald "renamed all call sites" claim → must exit 2; one hedged → must exit 0) to prove the referenced script path works from outside the guessless repo. Use the scratchpad for temp files, not markless.

Also record in your receipt: `git -C /Users/jacksm5pro/dev/open-source/markless status --porcelain` BEFORE and AFTER your edits, so the owner can distinguish your four paths from the pre-existing dirty entries.

## File contract

- /Users/jacksm5pro/dev/open-source/markless/AGENTS.md
- /Users/jacksm5pro/dev/open-source/markless/CLAUDE.md
- /Users/jacksm5pro/dev/open-source/markless/.claude/settings.json
- /Users/jacksm5pro/dev/open-source/markless/.claude/skills/guessless/**

## Forbidden moves

- No writes anywhere else in markless, and none in guessless. Why: additive integration under owner review; the machinery is already shipped.
- No `git commit`, `git push`, or `git add` in markless. Why: the owner reviews the working tree.
- Never remove or alter existing settings.json keys, hooks, or skill files. Why: markless has live tooling config and concurrent writers.

## Verification

```verify
node -e 'JSON.parse(require("fs").readFileSync("/Users/jacksm5pro/dev/open-source/markless/.claude/settings.json","utf8"));console.log("settings valid")'
grep -q 'guessless-integration:begin' /Users/jacksm5pro/dev/open-source/markless/AGENTS.md
grep -q 'guessless-integration:begin' /Users/jacksm5pro/dev/open-source/markless/CLAUDE.md
test -f '/Users/jacksm5pro/dev/open-source/markless/.claude/skills/guessless/SKILL.md'
grep -q 'claim-gate.mjs' /Users/jacksm5pro/dev/open-source/markless/.claude/settings.json
```

## Blocked permission

If the scope guard refuses these cross-repo writes, return status "blocked" IMMEDIATELY with the exact refusal text in open_questions — do not attempt workarounds through Bash. Likewise if evidence is missing or the contract conflicts with reality.