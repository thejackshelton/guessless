# T016 v5 Worker package

Decision: rejected. V4 is mechanically reproducible but not decision-grade. Preserve v3 and v4 byte-for-byte and never retry either.

## Objective

Implement the complete non-live `oracle-part-3-v5` protocol and independent oracle. Copy each task directory into `scratch/<task>/` and run Codex with `scratch` as both the visible CWD and Guessless root, so both arms use task-prefixed paths. Clarify that `reportedSiteIds` contains resolved requested sites, `unresolvedSiteIds` contains disjoint unresolved boundaries, paths begin with the task directory, and coordinates use the locked anchors below. Validate truth only from fixed source bytes and documented lexemes, never from GuesslessEngine, another parser, v4 outputs, or outcome-dependent tuning. Retain v4's model, exposure rule, 36-cell order, counterbalancing, budgets, validity, exact statistics, decision thresholds, one-shot behavior, and 82-file live topology. Add mutation-red calibration for path visibility, task prefixes, disjoint fields, coordinate anchors, oracle independence, transcript semantics, decisions, topology, replay, and immutable predecessor hashes. Publish a read-only v4 audit report. Create no v5 evidence or staging and make no model/network calls.

Locked truth:

- Rename resolved: `rename/alias.ts:2:38`, `rename/direct.ts:2:37`, `rename/higher-order.ts:2:42`, `rename/namespace.ts:2:51`; unresolved: none.
- Delete resolved: `delete/state.ts:3:2`, `delete/consumers.ts:2:39`, `delete/alias.ts:2:43`; unresolved: `delete/dynamic.ts:3:55`, anchored at the first computed-property-expression token.
- Reach resolved: `reach/boundaries.ts:1:23`, `reach/boundaries.ts:2:8`, `reach/cycle.ts:1:17`, `reach/cycle.ts:4:17`, `reach/entry.ts:2:17`, `reach/leaf.ts:1:14`, `reach/leaf.ts:2:17`, `reach/middle.ts:4:17`; unresolved: `reach/boundaries.ts:3:9`, anchored at the `import` keyword.

## Allowed files

- `packages/evaluation/src/contracts.ts`
- `packages/evaluation/src/codex.ts`
- `packages/evaluation/src/scoring.ts`
- `packages/evaluation/src/evidence.ts`
- `packages/evaluation/src/fixtures.ts`
- `packages/evaluation/src/cli.ts`
- `packages/evaluation/test/evaluation.test.ts`
- `packages/evaluation/dist/cli.js`
- `packages/evaluation/fixtures/oracle-part-3-v5/ground-truth.json`
- `packages/evaluation/fixtures/oracle-part-3-v5/oracle-rationale.json`
- `packages/evaluation/fixtures/oracle-part-3-v5/protocol.json`
- `packages/evaluation/fixtures/oracle-part-3-v5/response.schema.json`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/delete/alias.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/delete/consumers.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/delete/dynamic.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/delete/state.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/reach/boundaries.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/reach/cycle.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/reach/entry.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/reach/leaf.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/reach/middle.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/alias.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/api.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/barrel.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/direct.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/higher-order.ts`
- `packages/evaluation/fixtures/oracle-part-3-v5/input/rename/namespace.ts`
- `docs/evidence/oracle-part-3-v4-audit.md`

## Verify

- `pnpm build`
- Disabled-consent v5 fixture calibration.
- Disabled-consent v4 final verify and calibration.
- Disabled-consent v2 final verify and calibration.
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm exec vp check`
- Preserve exact v3 and v4 evidence hashes.
- Require `docs/evidence/oracle-part-3-v5` and every `.staging-oracle-part-3-v5-*` path absent.

## Stop if

- Any model, network, Codex login, live record command, v5 final evidence, or v5 staging path would be invoked or created.
- Any file outside the allowlist is needed.
- Any v1-v4 fixture/evidence byte changes, any v4 retry or rescore is attempted, or a frozen predecessor hash differs.
- V5 truth is derived, validated, or selected using GuesslessEngine, another parser, v4 arm outputs, or outcome-dependent tuning.
- The model-visible filesystem lacks task-prefixed paths identically for both arms, or Guessless and shell tools do not share the same root.
- Reported and unresolved fields overlap or remain ambiguous, task prefixes are not explicit, or a locked coordinate lacks source-byte and lexeme rationale.
- V5 changes any retained v4 rule beyond the approved oracle/path/field corrections.
- Any build, calibration, mutation, replay, predecessor verification, test, typecheck, lint, formatting, absence, or hash-preservation gate is red.
