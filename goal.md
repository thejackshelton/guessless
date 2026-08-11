# Guessless v1: ground truth for coding agents

## The pitch, fixed

> Your coding agent found 8 of the 12 call sites and told you it found all of them.
> **guessless** makes that impossible.

**guessless** answers structural and behavioural questions about a codebase **completely, or
names precisely what it could not resolve**. Every answer carries a receipt. An agent can cite a
guessless answer instead of asserting a conclusion.

The name is settled and the run does not relitigate it. It joins the family: markless frees you
from writing markup, frameless from committing to a framework, versionless from version
lock-in, **guessless from an agent's confident maybe**.

## The thesis: completeness is the product

The bug this exists to kill is **silent partial truth**. When an agent greps for call sites and
finds eight of twelve, the four it missed look exactly like four that do not exist. Nothing in
the transcript distinguishes them. The agent then reports a conclusion — refactor complete, no
other usages, safe to delete — with total confidence and no way for a reader to check.

This is not a retrieval-quality problem and **must not be pitched or built as one**. Better
recall still produces unmarked gaps. The product is the guarantee: an answer is
`complete`, or it is `partial` **with every unresolved site named**, or it is `refused` with a
reason. There is no fourth state, and a bare list of results is never a valid answer.

This is the same discipline as frameless's fail-closed rule — a construct that cannot be
classified produces a diagnostic naming its site, because a wrong mapping is invisible
downstream and a refusal is not — applied to agent tooling, where it is currently absent
industry-wide.

## Prior art: the category is occupied, and the gaps are specific

**Read these before designing anything.** Do not pitch guessless as "code intelligence for
agents"; that is taken several times over and a generic framing gets no attention and no users.

- [Serena](https://github.com/oraios/serena) — MCP toolkit, semantic retrieval and editing, LSP
  abstraction layer.
- [agent-lsp](https://blog.blackwell-systems.com/posts/agent-lsp/) — persistent LSP runtime, one
  Go binary, ~50 tools; `get_references` waits for indexing to complete.
- [mcpls](https://github.com/bug-ops/mcpls) — universal MCP↔LSP bridge.
- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — persistent knowledge
  graph, 158 languages, hybrid LSP type resolution, vector search, sub-ms queries.

Every one is an **LSP bridge or a retrieval index**. That inherits three weaknesses, and these
three are the entire differentiation. If a design decision does not serve one of them, it is out
of scope.

**1. They answer symbol questions, not behaviour questions.** LSP models definition, references,
hover, symbols. It does not model what a closure captures, which cells a function *writes* as
opposed to reads, what is reachable from an entry point, or what an effect body reaches through
three modules of custom hooks. Those are compiler questions. `capturesOf`, `referencesOf` and
`Analyzer.link()` answer them.

**2. They need a project that loads.** Resolving tsconfig, installed dependencies, a functioning
typecheck. Legacy code, Flow, half-broken builds, partial checkouts and mid-migration trees are
exactly where they fail — and exactly the corpus that matters (see versionless).

**3. None of them certify completeness.** They return references. They never say "this is all of
them, and here are the four sites I could not resolve, by name and reason." That omission is the
opening.

## The family this belongs to

- **frameless** (`~/dev/open-source/frameless`) — read `docs/goals/*/goal.md` for this charter
  format; `packages/analyzer/README.md` for how a contract states its own **oracle limits**
  rather than overclaiming; and `scripts/check-citations.mjs`, which exists because five of eight
  hand-corrected line ordinals had **already drifted, two within the commit that wrote them**.
  That guard is the origin story of this product: a human wrote 2,247 lines to catch after the
  fact what guessless should make impossible up front.
- **versionless** (`~/dev/open-source/versionless`) — behaviour-preserving legacy migration on
  Yuku 0.7.0: semantic preconditions, minimal byte-span edits, receipts with SHA-256 integrity,
  and explicit network phases. **Its receipt discipline is the model for guessless receipts**,
  and its corpus is the proof case for gap 2 above.
- **markless** (`~/dev/open-source/markless`) — read `@markless/core`'s `agent/markless.md`. The
  lesson to steal is narrower here: **prefer a build diagnostic over a guess**, and treat a
  refusal as information.

Prior local work on Yuku that must be read, not re-derived:

- `~/dev/open-source/frameless/.claude/worktrees/frameless-lift-baseui-v1/lift/` — `origin.mjs`
  identifies a construct **by where it is defined, never by how it is spelled**, so
  `import { useState as s }` and `React.useState` produce one origin while a local function named
  `useState` produces another. `cone.mjs` builds an import cone with fail-closed boundary
  reporting. These are working implementations of two things guessless needs.
- `~/dev/open-source/markerless-closure-extraction` — Yuku closure extraction with captures over
  a real React app. Already establishes that **author intent across files is not recoverable from
  structure**, which bounds what any capture-based answer may claim.

## The engine

`yuku-analyzer` 0.8.4. Project level: `Analyzer` with `addFile`, `removeFile`, `module`,
`link()`, `definitionOf(symbol)`, `referencesOf(symbol): ModuleReference[]`. Module level:
`symbolOf`, `referenceOf`, `scopeOf`, `parentOf`, `resolve(name, scope, space)`, `capturesOf`,
`exportedNames`, `walk`, plus `imports` and `exports` records and `Scope`/`Symbol`/`Reference`
structures.

Language scope for v1 is **JavaScript and TypeScript, including JSX/TSX** — what Yuku parses.
Any other language is a refusal, not a gap. Do not add a second parser.

## The query surface

Two tiers. The first is table stakes and must be correct; the second is why anyone switches.

**Tier 1 — symbol questions.** `definitionOf`, `referencesOf`, `exportedNames`, scope and
binding resolution. Correctness here is assumed by users and must be proven anyway, because tier
2 answers are built on it.

**Tier 2 — behaviour questions. This is the product.** At minimum:

- **`capturesOf(fn)`** — what does this closure actually close over, shadowing-correct.
- **writes vs reads** — which references to a symbol *mutate* it, separated from those that read
  it. This single distinction is absent from every LSP bridge and is what makes "is it safe to
  change this" answerable.
- **`reachableFrom(entry)`** — the transitive symbol set reachable from an entry point, with
  every boundary the walk stopped at named.
- **`reaches(fn)`** — what a function body reaches *through* intermediate modules and wrappers,
  so "what does this effect actually do" survives three layers of custom hooks.

The run may add queries, but every added query must carry its own receipt semantics. **A query
that cannot state its own completeness does not ship.**

## The receipt contract

The differentiated artifact. Design it first; the queries are downstream of it.

Every answer is exactly one of:

- **`complete`** — the engine asserts this is all of them. Requires that every construct
  encountered was classifiable.
- **`partial`** — results, plus **every unresolved site named** with a file, a symbol-anchored
  location, and a machine-readable reason (dynamic member access, computed key, string-keyed
  lookup, unparsed file, unresolved specifier, boundary of the linked set, and so on).
- **`refused`** — no results, with a reason. A refusal is a legitimate answer.

Hard rules:

- A bare list is never a valid answer. Every response carries a state.
- **Citations are symbol-anchored, not line ordinals.** Line numbers into first-party files rot
  silently; frameless measured this and built a guard for it. A guessless citation must remain
  correct when code moves.
- Unresolved reasons are a **closed enumeration**, extended by ruling. "Other" is not a reason.
- A `complete` answer that is later shown incomplete is the **most severe defect class in this
  project** and every instance gets a recorded finding.

## The oracle

Three parts. All required. A part that cannot be met is reported as unmet with its evidence,
never softened.

**1. THE RECEIPT IS PROVEN HONEST — this blocks everything else.** An adversarial corpus with
*known planted* ground truth: aliased imports, namespace member access, re-exports and
`export *` chains, shadowed locals sharing a name with an import, dynamic member access, computed
and string-keyed property access, a call through a higher-order wrapper, and a reference inside a
file that fails to parse. For each fixture the planted answer is known in advance. Every query
must return either the complete correct set marked `complete`, or a `partial` whose named
unresolved sites **cover every planted site it missed**. **A site that is both missed and unnamed
is a total failure of the thesis** and is recorded as such, not smoothed over. Fixtures the
engine is *expected* to miss are mandatory — a corpus it always answers `complete` on has proven
nothing.

**2. IT ANSWERS ON CODE THAT DOES NOT BUILD.** At least three pinned real repositories that fail
a clean typecheck, lack installed dependencies, use Flow, or are mid-migration — the versionless
corpus is the natural source. guessless returns useful, receipted answers on all of them. For
comparison, **run at least one LSP-based tool from the prior-art list on the same inputs and
record its verbatim output**, including the case where it does fine. An honest comparison that
weakens the claim is a result; a missing comparison is not.

**3. AN AGENT MEASURABLY STOPS GUESSING.** A task set where the correct answer requires finding
**all** N sites (rename every caller, delete a symbol safely, enumerate everything an entry
reaches). Agents run the tasks with and without guessless, scored on **sites missed** and on
**false claims of completeness**. Both arms use the same model and prompt; only the tool access
differs. Without this part the project is an unvalidated tool with a good story, so it does not
get dropped for time — if it must be narrowed, narrow the task count and say so.

**Completion proof**: the part-1 falsification ledger with every fixture's planted set and
verdict; part-2 receipted answers on three named pinned repositories beside the verbatim
comparison output; and the part-3 scored task table with both arms. Any part unmet is stated as
unmet.

## Deliverable shape

**Engine, then MCP server, then CLI — in that order.**

The engine is a library with no transport, testable headlessly. The MCP server is a thin
adapter, because MCP is how agents will actually consume this and it is the distribution story.
The CLI exists so a human can check any answer the agent got, which is what makes the receipt
worth anything.

Index build cost and query latency are **measured and published**, not claimed. If a large
repository takes minutes to link, that is a number in the README, not a footnote.

## Non-goals for v1

- **Not a search engine.** No embeddings, no vector search, no fuzzy retrieval. Those produce
  ranked guesses, which is the thing being replaced.
- **No code editing or writing.** Answers only. Editing is a different trust model.
- **Not a linter.** Findings are answers to questions, not a rule set.
- **No second language.** JS/TS/JSX/TSX via Yuku. Other languages are refusals.
- **No hosted service, auth, or persistence layer.** Local index, local process.

## Working rules

- **Nothing is guessed.** A construct that cannot be classified produces a fail-closed diagnostic
  naming its site. This is the product, not just the process.
- **Identify constructs by where they are defined, never by how they are spelled.** `origin.mjs`
  is a working implementation; read it before writing another.
- **Cite by symbol, not by line ordinal**, in receipts and in the project's own documents.
- **A guard never shown to fail is worse than no guard.** Every check this project adds is
  mutated, watched to go red, and restored byte-identically before it counts.
- **Negative results are deliverables.** "The engine cannot resolve this class, and here is the
  fixture" is worth more than a claim that was never attacked.
- Pin every fixture repository by commit and record its licence.
- Measure before claiming. Every number in a document is produced by a command that is recorded.

## Open questions for the run to answer

1. What is the closed enumeration of unresolved-reason codes, and what forced each one in?
2. What fraction of references in a real repository are resolvable to `complete`, and what is the
   shape of the tail? This number decides how strong the pitch may honestly be.
3. Can `writes vs reads` be answered soundly for property mutation through an alias
   (`const a = obj; a.x = 1`), or is that a named refusal in v1?
4. What is the index build cost and query latency at 10k, 100k, and 1M lines?
5. Does an incremental `addFile`/`removeFile` update preserve receipt honesty, or must a mutated
   file invalidate `complete` answers that depended on it?
