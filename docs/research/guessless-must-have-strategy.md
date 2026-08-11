# Guessless must-have strategy

## Thesis

Guessless should become a **JavaScript/TypeScript prepared-snapshot safe-change oracle**. For a proposed rename, deletion, or entry-point change, it should return resolved, role-labelled sites; every explicit unresolved boundary; snapshot and provenance identity; and expandable proof. The workflow budget is at most two cold calls—prepare, then impact—and one warm call against an unchanged prepared snapshot.

This wedge is narrower and more valuable than exposing more analyzer primitives. It answers the agent's decision: “What does this change affect, what remains unproven, and why?” It preserves Guessless's fail-closed boundary rather than competing with text search or a general code-query language.

## Causal correction from v5

**Observed fact.** The decision-grade v5 benchmark completed 36 cells and 18 pairs, with treatment/control correctness of 4/5 for rename, 0/0 for delete, and 6/4 for reach. Treatment added false completeness and incurred material overhead ([adoption decision](../evidence/oracle-part-3-adoption-decision.md), [sealed decision](../evidence/oracle-part-3-v5/decision.json)).

**Observed fact.** All 68 v5 Guessless MCP calls were cancelled with `user cancelled MCP tool call`: 41 `add_file` attempts, 26 `link` attempts, and one structural-query attempt. No call delivered engine output to the agent ([T001 local audit receipt](../goals/guessless-must-have-research/state.yaml), [representative reach transcript](../evidence/oracle-part-3-v5/raw/r01-reach-guessless.stdout.jsonl)). Invocation counting starts when a tool call starts, so an invocation is not evidence of a successful result ([evaluator transcript accounting](../../packages/evaluation/src/codex.ts)).

**Inference.** The 6/6 treatment reach result is not causal evidence of semantic benefit from Guessless. Possible explanations include tool affordance, forced deliberation, or ordinary model variation; the engine result cannot be one because none arrived.

**Hypothesis.** If preparation and execution become reliable and task-shaped, the engine's receipt semantics can improve safe-change decisions. That hypothesis remains unproven and must pass the experiments below.

**Observed fact.** The local engine is already much faster than the end-to-end cells: published synthetic engine queries range from milliseconds at 10,000 lines to roughly 33–279 ms p50 at one million lines, while agent cells take tens of seconds ([local performance evidence](../../README.md)). **Inference.** Transport, preparation, selection, and answer shaping are therefore more credible first bottlenecks than raw query execution.

## What to build conceptually

**Hypothesis: prepared snapshot.** One cold preparation call accepts a root or batch, normalizes canonical JavaScript/TypeScript paths, links once, and returns an immutable snapshot handle with coverage and provenance. A warm query reuses it; changed input produces a new identity, and stale handles refuse deterministically.

**Hypothesis: safe-change impact.** One task-shaped query accepts the snapshot plus a change intent:

- rename a semantic symbol;
- delete a declaration or export;
- change/remove an entry point and inspect its reachable slice.

The inline answer contains state (`complete`, `partial`, or `refused`), resolved sites with roles such as declaration/read/write/call/import/export/witness, every unresolved boundary and closed reason, snapshot/integrity identity, and a proof handle. Expanded proof supplies full anchors, relationships, and witnesses on demand. Coordinates are projections of stable semantic identity, not identity themselves.

**Transfer.** This shape combines reusable preparation, narrow operations, stable identity, explicit proof paths, and progressive result detail found in adjacent systems while retaining Guessless's JS/TS-only and fail-closed contract. It does not import compiler-scale indexing, a query language, or silent fallback.

## Compactness verdict

Compact semantic output matters, but it is **fifth-order leverage**—after reliable execution, batch/root preparation, task-shaped impact answers, and reusable snapshots. **Observed fact.** The current MCP surface has per-file add/remove/link and nine primitive queries, with no batch preparation, snapshot handle, safe-change query, compact projection, pagination, or proof handle ([MCP implementation](../../packages/mcp/src/index.ts)). Existing receipts repeat anchors and witness detail but already preserve valuable state, unresolved reasons, snapshot hashes, integrity, and provenance ([engine contracts](../../packages/engine/src/contracts.ts)).

**Go threshold.** A progressive initial view must reduce initial result bytes by at least 50% and downstream agent tokens by at least 25% versus the full receipt, with identical answer quality, no hidden unresolved site, no extra median follow-up call, and no latency regression.

**Falsifier.** Reject the compact view if it changes correctness or receipt state, hides any unresolved boundary or identity/integrity field, increases median calls, or merely shifts bytes into mandatory expansions. Keep full proof available by stable handle. Text plus `structuredContent` duplication should not be removed without client compatibility evidence because MCP recommends text fallback for compatibility.

## Ranked intervention portfolio

Confidence labels reflect current evidence, not implementation certainty. Cost is relative engineering effort.

| Rank | Workflow | Mechanism | Expected value | Confidence | Cost | Main risk | Verification | Target metric | Falsifier |
| ---: | -------- | --------- | -------------- | ---------- | ---- | --------- | ------------ | ------------- | --------- |
| 1 | Any agent tool call | Instrument request lifecycle, cancellation reason, progress, and recovery | Establishes that a semantic answer can arrive and failures are diagnosable | High | Medium | Client cancellation may be outside server control | Deterministic transport harness across clients | At least 99% completion; 100% failure attribution; zero unexplained cancellations over 200 calls | Any unexplained cancellation or recovery requiring silent state loss |
| 2 | Cold project start | Root/batch ingestion prepares one immutable snapshot | Removes per-file upload/link choreography and makes coverage explicit | High | Medium-high | Root trust, ignored files, or partial coverage could overclaim completeness | Corpus parity against explicit per-file preparation; mutation-red stale tests | One prepare call; at least 80% setup-byte reduction; exact coverage; deterministic stale refusal | Coverage differs, stale state is accepted, or setup savings miss target |
| 3 | Rename/delete/entry-point change | One safe-change impact query projects role-labelled sites and unresolved boundaries | Converts analyzer machinery into a direct engineering decision | Medium-high | High | Task contract may encode the wrong notion of “affected” | Blinded real-repository paired tasks with adjudicated truth | Zero added false completeness; no task regression; at least 15-point correctness gain; median semantic calls at most 2 | Any added false completeness, regression, or gain below threshold |
| 4 | Repeated work in one project | Reuse immutable snapshots; incrementally prepare changed files | Cuts warm setup and latency while retaining integrity | Medium | High | Cache invalidation can corrupt proof | Cold/warm equivalence and adversarial invalidation suite | At least 70% warm transferred-byte and 30% warm latency reduction; semantic equivalence modulo snapshot ID | Any stale acceptance or cold/warm semantic disagreement |
| 5 | Successful result consumption | Stable symbol identity, role-safe coordinate projection, concise initial result, expandable proof | Reduces context without weakening trust or correction ability | Medium | Medium | Compaction can hide evidence or cause proof churn | Full-versus-progressive blinded A/B | Zero coordinate-role errors; initial bytes down at least 50%; downstream tokens down at least 25%; no extra calls/quality loss | Hidden unresolved site, changed answer, extra median call, or missed savings |
| 6 | Natural tool discovery | Clear task names/descriptions, explicit JS/TS scope, machine-readable capability/coverage | Improves unforced selection and prevents overbroad claims | Medium | Low-medium | Prompt wording can look good only in synthetic tasks | Unforced discovery trial among competing tools | At least 80% correct natural selection; zero claims outside JS/TS/proven coverage | Selection below 80% or any overbroad proof claim |

**Inference.** Reliability and batching are prerequisites, not the differentiator. The must-have value arrives only when task-shaped safe-change answers outperform ordinary tools without sacrificing honesty.

## 90-day staged roadmap

Each stage is gated. Missing a gate stops downstream product claims; it does not authorize weakening the metric.

### Days 0–15: reliable execution and cancellation diagnosis

Build a deterministic transport test surface before measuring semantic value. Require at least 99% completed calls, reasons for 100% of failures, and zero unexplained cancellations over 200 calls. Recovery must not require re-uploading unchanged state. A miss keeps the project in transport repair.

### Days 16–35: one-call preparation and immutable snapshots

Evaluate a conceptual root/batch preparation path against explicit file-by-file indexing. Require one prepare call, at least 80% fewer setup bytes, exact source coverage, stable provenance, and deterministic refusal of stale snapshot handles. Any coverage disagreement or stale acceptance is a no-go.

### Days 36–55: safe-change impact on blinded real repositories

Test rename, delete, and entry-point impact on licensed, held-out JavaScript/TypeScript repositories. Require zero added false completeness, no task regression, at least a 15-percentage-point correctness gain, and no more than two median semantic calls. Benchmark-tuned coordinate conventions or synthetic-only wins do not pass.

### Days 56–70: full versus progressive receipt A/B

Compare identical semantic answers with full and progressive proof. Require at least 50% fewer initial bytes and 25% fewer downstream tokens, with no quality, median-call-count, or latency loss and no hidden unresolved site. If it fails, retain full receipts and continue without a compact mode.

### Days 71–90: preregistered natural-discovery trial

Run a paired trial without forced-use prompts. The final **must-have go gate** requires all of:

- at least 99% call completion;
- at least 80% unforced correct tool selection;
- at most two cold calls and one warm call per workflow;
- zero added false completeness and no task regression;
- at least four net paired correctness wins with one-sided exact `p <= 0.10`;
- at least 20% lower end-to-end workflow time or 25% fewer total tool calls.

**Go.** Passing every condition supports a reversible sibling-repository pilot of the prepared-snapshot safe-change oracle.

**No-go.** Failure of any condition means it is not yet a must-have. Publish the miss, retain the useful engine, and address the failed causal layer before integration. No sealed v3, v4, or v5 evidence is changed or reinterpreted.

## No-go ideas

- Compact before obtaining successful-result baselines.
- Add more primitive tools instead of task-shaped workflows.
- Use forced-use prompts as evidence of product selection or value.
- Add silent text-search, parser, or language fallback that weakens fail-closed receipts.
- Hide unresolved sites behind opaque handles or omit state/snapshot/integrity from the initial answer.
- Inline every witness unconditionally.
- Expand beyond JavaScript/TypeScript before the safe-change gate passes.
- Build UI polish before the causal workflow gate.
- Cache without immutable identity, provenance, and mutation-red invalidation.
- Optimize for the existing synthetic benchmark or retry/rescore immutable evidence.

## Primary-source basis

All external sources below were accessed 2026-08-09.

| Primary source | Observed pattern | Transfer to Guessless | Boundary |
| -------------- | ---------------- | --------------------- | -------- |
| [Language Server Protocol overview](https://microsoft.github.io/language-server-protocol/) and [LSP 3.17 specification](https://github.com/Microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md) | Narrow requests, document/workspace synchronization, work progress, and partial-result tokens | Separate preparation/state from task-shaped queries; expose progress | Editor-owned live documents do not provide integrity-protected completeness receipts |
| [SCIP schema](https://raw.githubusercontent.com/sourcegraph/scip/main/scip.proto), [Sourcegraph precise navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation), and [auto-indexing](https://sourcegraph.com/docs/code-navigation/auto-indexing) | Workspace-rooted reusable indexes, indexer provenance, canonical paths, stable symbols, occurrence roles, relationships, asynchronous indexing | Prepared snapshot, provenance, stable semantic identity, and role-labelled evidence | Compiler-backed multi-language/package identity and CI indexing are heavier than Guessless's JS/TS wedge |
| [CodeQL overview](https://codeql.github.com/docs/codeql-overview/about-codeql/), [path queries](https://codeql.github.com/docs/writing-codeql-queries/creating-path-queries/), and [annotations](https://codeql.github.com/docs/ql-language-reference/annotations/) | Snapshot databases, reusable queries, explicit source-to-sink path evidence, cached predicates | Separate prepared state from queries and make proof expandable | Build extraction, database weight, a query language, and security specialization are disproportionate here |
| [GitHub SARIF support](https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/sarif-files/sarif-support) | Compact finding summaries can reference related locations/code flows; partial fingerprints correlate results | Inline decision summary plus expandable evidence and correlation identity | A SARIF finding model is not a completeness proof for structural impact |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) and [cancellation specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation) | Discovery schemas, structured results, pagination/list changes, cancellation reasons, logging/UI handling; text fallback supports compatibility | Explicit capabilities, structured impact result, pagination/proof expansion, and attributable cancellation | Tool registration cannot guarantee execution; clients and users may cancel |

These sources support transferable architecture patterns, not popularity-based product claims. The proposed wedge remains a falsifiable hypothesis until the final gate passes.
