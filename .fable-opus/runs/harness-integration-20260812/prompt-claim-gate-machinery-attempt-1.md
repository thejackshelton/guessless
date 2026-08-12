Fable-Opus-Unit: harness-integration-20260812/claim-gate-machinery
Fable-Opus-Timeout-Minutes: 45

## Goal

Build the guessless claim-gate machinery: two scripts, an integration guide, and tests, inside the guessless workspace.

**`scripts/claim-gate.mjs`** — a Claude Code Stop-hook adapter. Contract facts you need (from the Claude Code hooks interface): the hook process receives a single JSON object on stdin with fields including `session_id`, `transcript_path` (path to the session's JSONL transcript), and `hook_event_name`. To evaluate the agent's final message, read the transcript JSONL and extract the last assistant message's text content. To BLOCK the stop, either exit with code 2 and write the reason to stderr, or print a JSON object `{"decision": "block", "reason": "..."}` to stdout and exit 0; to allow, exit 0 with no decision. Also support a `--check <file>` mode that reads a plain-text claim (plus optional `--receipt <path>`) for direct testing and CI use, sharing the same core logic.

Gate logic, fail-open by design (only completeness claims are gated):
1. Scan the message for JS/TS structural completeness claims — patterns like "all call sites", "all references", "no other usages/references", "every caller/usage renamed/updated", "safe to delete", "nothing else imports/uses". Case-insensitive, word-boundary aware; keep the pattern list in one exported array with a comment inviting extension.
2. No claim → allow (exit 0).
3. Claim present → look for a cited receipt: an inline JSON block with `"schema": "guessless.receipt/v1"`, or a referenced `*.receipt.json` path that exists and parses. No receipt → block with a message telling the agent to attach a guessless receipt or qualify the claim (say "which sites were checked" instead of "all").
4. Receipt present → consistency check: `state: "complete"` → allow. `state: "partial"` → allow only if the message acknowledges gaps (mentions "partial", "unresolved", "except", "gaps", or enumerates the unresolved count); otherwise block quoting the receipt's unresolved count. `state: "refused"` → block any completeness claim. Malformed receipt → block, saying the receipt did not parse.

**`scripts/reproduce-check.mjs`** — given directory or file arguments (and `--help`), finds `*.receipt.json` reproduction bundles: for each, if a sibling `*.reproduction.json` (inputs + receipt) exists, run `node packages/cli/dist/cli.js reproduce <bundle>` from the guessless root (locate the root relative to the script's own path so target repos can call it by absolute path); a receipt without a reproduction bundle is reported as unverifiable (non-zero unless `--allow-unverifiable`). Exit non-zero on any non-reproduction. Check the CLI's actual `reproduce` input shape in `packages/cli/src/` first and follow it exactly.

**`docs/integration.md`** — the four-layer guide (docs block, skill, stop-hook, CI) with copy-paste blocks: the AGENTS.md section, a complete `.claude/skills/guessless/SKILL.md` (valid frontmatter: `name`, `description` with trigger conditions), the `.claude/settings.json` hooks entry for a Stop hook invoking `node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs`, and the CI reproduce-check invocation. State the honest adoption facts: agents do not pick the tool up voluntarily (measured 0%); the hook and CI layers are the enforcing ones.

**Tests** — `scripts/claim-gate.test.mjs` (or under a test dir the workspace's vitest picks up; wire into `pnpm test` via vite.config.ts if needed): unreceipted claim → block; receipted complete claim → allow; partial receipt + bald "all" claim → block; partial receipt + acknowledged gaps → allow; no claim → allow; refused receipt + claim → block; malformed receipt → block; transcript-mode extraction of the last assistant message; reproduce-check pass and tamper-fail (flip one byte in a real receipt produced by the CLI in the test). Use real CLI invocations for the reproduce tests (the workspace builds dist).

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`. Then `pnpm build` before reproduce tests.

## File contract

- `scripts/**`
- `docs/integration.md`
- `vite.config.ts`
- `package.json`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch `packages/**` sources or anything under `docs/` except `docs/integration.md`. Why: the engine/CLI are the shipped artifacts under test; evidence and boards are immutable.
- Do not make the gate block non-claims or hedge-phrased answers. Why: a gate that cries wolf gets removed; it must fire only on unpriced completeness claims.
- Do not invent a different hook contract; if the stdin/transcript shapes above prove wrong against reality, return blocked with what you observed. Why: a hook that never fires is worse than no hook.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
node scripts/claim-gate.mjs --check /dev/null
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (hook contract, CLI reproduce shape), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.