Fable-Opus-Unit: must-have-fixes-20260811/d6-workspace-specifiers
Fable-Opus-Timeout-Minutes: 45
Fable-Opus-Effort: high
Effort-Justification: Owner-approved post-breaker unit closing the last known honesty class at repo scale; the falsifiable demonstration re-run scores it mechanically, so a shallow fix fails loudly and wastes the budget extension.

## Goal

Fix defect class D6 and re-run the must-have demonstration. Evidence: `docs/evidence/adoption-eval-fable-v2/demonstration/report.md` (falsifier F2 analysis).

**D6.** A supplied input file whose only route to the corpus is a workspace package-name specifier (`import { X } from '@markless/serializer'`) is invisible in traversal receipts: `boundaryReason` (`packages/engine/src/linking.ts:89-92`) only assigns `unlinked-input` when the failed specifier path-suffix-matches a supplied input path; `@markless/serializer` normalises to `markless/serializer`, matches nothing, is classified `external-module-boundary`, and `unlinkedInputSites` (`linking.ts:113-141`) skips it — so the file is outside the dependents closure AND outside the naming pass. In the demonstration this silently dropped 19 real sites in 6 files (e.g. `packages/web/src/fns/ssr.ts`, `packages/compiler/src/passes/public-render/shared.ts`).

Required behavior, fail-closed: a supplied input that references the queried name but could not join the linked graph must never be silent. Choose the honest mechanism:
- (a) Extend the supplied-input index with workspace package-name mapping: when supplied inputs include `package.json` manifests (or when supplied paths follow a `packages/<name>/src/**` shape you can prove from the supplied set alone), map `@scope/name`-style specifiers to their supplied entry files, so those imports LINK when the target is supplied — turning silence into results; AND still name residual unresolvable cases. Note: the demonstration input set was 635 `.ts` files with no package.json — your mechanism must work for that shape too, so a supplied-roots heuristic (e.g. specifier tail `serializer` matching supplied root `packages/serializer/`) may be the primary path; document its precision bounds honestly and keep it fail-closed (over-name rather than guess a link when ambiguous — do NOT link on a heuristic match unless the mapping is unambiguous within the supplied set; if ambiguous, name it).
- (b) At minimum, `unlinkedInputSites` must also name supplied inputs stranded behind `external-module-boundary` specifiers when those specifiers could plausibly denote a supplied root (scoped/bare specifiers whose tail matches a supplied directory root). An honest new closed reason is allowed if `unlinked-input`'s documented meaning doesn't stretch (currently 19 members).

Class regression tests in `packages/engine/test/`: multi-package fixture with `@scope/pkg` specifiers — target supplied (must link or be named, never silent); ambiguous tail matching two supplied roots (must name, never guess-link); genuinely external package untouched by the corpus (stays external-module-boundary, no noise); the existing 239-test gate stays green.

**Then re-run the demonstration** (protocol in `demonstration/report.md` and `run-demo.mjs`; corpus READ-ONLY via `git archive 931f0544` exactly as before; rebuild the engine in your worktree first). Update `demonstration/` receipts, scores.json, and report.md. The claim stands only if `score-demo.mjs` exits 0 (P1–P5 all pass). If any falsifier fires again, report blocked leading with the receipt — never soften.

You are in a fresh git worktree without node_modules. FIRST command: `pnpm install --frozen-lockfile --prefer-offline`.

## File contract

- `packages/engine/src/**`
- `packages/engine/test/**`
- `packages/*/dist/**`
- `docs/evidence/adoption-eval-fable-v2/demonstration/**`
- `pnpm-lock.yaml`

## Forbidden moves

- Do not touch the markless repo, `docs/evidence/adoption-eval-fable-v1/**`, v2 files outside `demonstration/`, or mcp/cli/oracle/evaluation sources. Why: read-only corpus, immutable eras, adapters inherit the engine.
- Do not guess-link on ambiguous specifier matches. Why: a wrong link manufactures false results — worse than the silence it replaces.
- Do not weaken score-demo.mjs or the ground truth. Why: the demonstration is only worth what it can refuse.

## Verification

```verify
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm test
pnpm typecheck
pnpm lint
node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs
```

## Blocked permission

If evidence is missing, the contract conflicts with reality, a falsifier fires on the re-run (expected blocked path — lead with the receipt), dependencies cannot install, or you need a file outside the contract, return status "blocked" with the question in open_questions instead of improvising.