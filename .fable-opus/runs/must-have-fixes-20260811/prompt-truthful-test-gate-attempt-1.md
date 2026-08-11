Fable-Opus-Unit: must-have-fixes-20260811/truthful-test-gate
Fable-Opus-Timeout-Minutes: 45

## Goal

Make `pnpm test` truthful in a fresh checkout of the guessless workspace. Today, at baseline commit 09ef2ee in a clean worktree (which is where you are), `pnpm test` fails 13 tests even though the code is healthy, because parts of the suite depend on untracked state and on frozen built-artifact hashes:

1. v7–v11 evaluation tests pin the sha256 of a stale built `packages/engine/dist/index.js` that only exists (in matching form) in the maintainer's main checkout.
2. `packages/oracle` tests fail with ENOENT on fixtures that are untracked.
3. `packages/evaluation/test/v6-evaluation.test.ts` pins the sha256 of the *current* engine bundle, so any engine source change whatsoever fails it — this permanently blocks engine development through the gate.

Restructure so evidence-era integrity tests stop gating current product development, WITHOUT deleting or weakening any assertion:

- Gate the manifest/hash-pinning evaluation suites (v6 through v11) and any environment-dependent oracle suites behind an explicit opt-in — an env flag such as `GUESSLESS_EVIDENCE_TESTS=1` checked via `describe.skipIf`/early bail, or a separate non-default vitest project — so the default `pnpm test` runs only environment-independent product tests.
- For the oracle ENOENT fixtures, prefer making the fixtures self-generating or tracked under `packages/oracle/fixtures/**` if they are small and deterministic; gate them like the evidence suites only if generation is not feasible.
- Every gated file gets a short header comment stating what it verifies, why it is opt-in, and the exact command to run it.
- The gated suites must still RUN and behave identically under the opt-in flag (you don't need them green under the flag in this worktree — they pin another era's artifacts — but they must be runnable and their assertions untouched).

Acceptance is mechanical and is your verify block: in this fresh worktree, install, build, and the full default gate green. Baseline for comparison: before your change, `pnpm test` here fails 13.

Your FIRST command must be `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/evaluation/test/**`
- `packages/oracle/test/**`
- `packages/oracle/fixtures/**`
- `vite.config.ts`
- `package.json`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not edit `packages/evaluation/fixtures/**` or anything under `docs/` — sealed evidence and preregistrations are immutable. Why: resealing evidence to make tests pass would destroy the very integrity those tests exist to witness; the fix is gating, not resealing.
- Do not delete or weaken any assertion; gating must preserve each test's body byte-for-byte where feasible. Why: the suites remain the honest record of what their evidence eras pinned.
- Do not touch `packages/engine/**`, `packages/mcp/**`, `packages/cli/**` sources. Why: a concurrent review branch holds engine changes; this slice must merge cleanly beside it.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Blocked permission

If evidence is missing, the contract conflicts with reality (e.g. a failing test is neither hash-pinned nor fixture-dependent but a real product defect), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.