# Integrating guessless into an agent workflow

This is the adoption guide: how to put guessless in front of an agent that is about to claim it
renamed every call site, and how to make that claim mechanically checkable later.

It has four layers. They are not alternatives — they escalate, and only the bottom two enforce
anything.

| Layer | File | What it does | Does it enforce? |
| --- | --- | --- | --- |
| 1. Docs | `AGENTS.md` / `CLAUDE.md` | Tells the agent the tool exists and when to reach for it | No |
| 2. Skill | `.claude/skills/guessless/SKILL.md` | Loads the how-to on demand, so the agent does not have to remember the envelope shapes | No |
| 3. Stop hook | `.claude/settings.json` | Refuses to let a turn end on an unpriced completeness claim | **Yes, in the loop** |
| 4. CI | your workflow file | Re-runs every committed receipt and fails the build if one does not reproduce | **Yes, at merge** |

Read the [adoption facts](#adoption-facts-what-is-actually-measured) before deciding how much of
this to install. The short version: layers 1 and 2 are documentation, and documentation has never
been measured to make an agent pick this tool up on its own.

---

## Layer 1 — the docs block

Paste this into the target repository's `AGENTS.md` (or `CLAUDE.md`). It is deliberately short:
long tool documentation competes with the task for attention.

```markdown
## Structural claims about JavaScript/TypeScript

Do not assert that you have found *all* call sites, *every* reference, or that a symbol is safe to
delete, unless you can show a guessless receipt for that exact claim. `grep` cannot see re-exports,
aliased imports, `export * from`, or property access through a namespace object, so "all" derived
from a text search is a guess.

To price a completeness claim:

    node <guessless>/packages/cli/dist/cli.js query envelope.json

where `envelope.json` is `{"inputs": [{"path": "...", "source": "..."}], "request": {...}}`. The
answer is a receipt whose `state` is one of:

- `complete` — the result set is exhaustive. This is the only state that licenses the word "all".
- `partial` — plus a named `unresolved` site for every place the engine could not classify. Say the
  answer is partial and name the gaps.
- `refused` — the question was not answered. It supports no claim at all.

If you have no receipt, say which sites you checked instead of saying "all". A qualified answer is
always acceptable; an unpriced "all" is not.
```

Replace `<guessless>` with the absolute path to your guessless checkout, or drop the path entirely
if guessless is installed as a dependency and `guessless` is on `PATH`.

---

## Layer 2 — the skill

A skill keeps the envelope shapes out of the main context until they are needed. Create
`.claude/skills/guessless/SKILL.md` in the target repository:

````markdown
---
name: guessless
description: Prove structural claims about JavaScript/TypeScript with a guessless receipt. Use when about to say "all call sites", "every reference", "nothing else imports this", or "safe to delete"; when renaming or deleting an exported symbol; when a claim gate has blocked a turn asking for a receipt; or when auditing whether a change is complete. Do not use for non-JS/TS languages.
---

# Proving a structural claim with guessless

Guessless answers reference/definition/reachability questions about JavaScript and TypeScript and
returns a signed receipt that is either exhaustive or explicitly incomplete. It never returns a bare
list, so every answer is either usable as proof or self-labelled as a gap.

## 1. Build the query envelope

Guessless is hermetic: it reads sources out of the envelope, not off disk. That is what makes a
receipt reproducible later.

```json
{
  "inputs": [{ "path": "src/storage.ts", "source": "<file contents>" }],
  "request": { "kind": "exportedNames", "file": "src/storage.ts" }
}
```

Include every file that could plausibly reference the symbol. A file you leave out is not a file
guessless says is clean — it is a file guessless never saw.

Request kinds:

| Kind | Fields | Answers |
| --- | --- | --- |
| `referencesOf` | `target` (symbol anchor) | Every reference to a symbol |
| `definitionOf` | `target` | Where a symbol is defined |
| `readsOf` / `writesOf` | `target` | Reads or writes of a binding |
| `capturesOf` | `target` | Closures capturing a binding |
| `reachableFrom` / `reaches` | `target` | Call-graph reachability |
| `exportedNames` | `file` | The module's export surface |
| `resolveBinding` | `file`, `name`, `space`, optional `scope` | What a name resolves to |

Get a symbol anchor from an `exportedNames` or `definitionOf` receipt and pass it back verbatim —
anchors are fingerprinted, so hand-editing one invalidates it.

## 2. Run it

```bash
node <guessless>/packages/cli/dist/cli.js query envelope.json > answer.receipt.json
```

## 3. Read the receipt honestly

- `"state": "complete"` — say "all", and paste or cite the receipt.
- `"state": "partial"` — every place the engine could not classify is named in `unresolved`. Say the
  answer is partial, give the count, and name the gaps. Do not round a partial up to "all".
- `"state": "refused"` — `reason` and `detail` say why. Do not claim anything; fix the cause (often a
  non-JS/TS file) and re-query.

## 4. Make it checkable

Write the receipt beside a reproduction bundle so CI can re-run it:

```
answer.receipt.json         the receipt
answer.reproduction.json    {"inputs": [...same inputs...], "receipt": {...that receipt...}}
```

Then `node <guessless>/scripts/reproduce-check.mjs <dir>` re-runs it and fails if a single byte of
the receipt was altered.

## Boundaries

JavaScript, TypeScript, JSX and TSX only. Guessless has no opinion about other languages, about
runtime behaviour, or about whether a change is *correct* — only about whether a structural answer
is complete.
````

The frontmatter is the whole trigger mechanism: `name` must match the directory, and `description`
must name the *conditions* under which to load the skill, because that description is all the agent
sees until it decides to open the file.

---

## Layer 3 — the Stop hook (the first layer that enforces)

`scripts/claim-gate.mjs` is a Claude Code `Stop` hook. When a turn ends, it reads the last assistant
message out of the session transcript, looks for an unhedged structural completeness claim, and
blocks the stop if the claim has no receipt behind it.

Add to the target repository's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`Stop` hooks take no `matcher` — they run on every turn end. Use the absolute path to your guessless
checkout; the script has no dependencies beyond Node ≥ 22 and does not need to run from the
guessless directory.

### What it does and does not block

The hook receives the standard hook payload on stdin (`session_id`, `cwd`, `transcript_path`,
`hook_event_name`, `stop_hook_active`), reads the JSONL transcript, and evaluates the last assistant
message that carries text.

| Final message | Outcome |
| --- | --- |
| No completeness claim | allow |
| "I did not check every caller" (hedged) | allow — hedges are qualified statements, not claims |
| "Updated all call sites." | **block** — attach a receipt or qualify the claim |
| Claim + `complete` receipt | allow |
| Claim + `partial` receipt, gaps acknowledged | allow |
| Claim + `partial` receipt, bald "all" | **block**, quoting the unresolved count |
| Claim + `refused` receipt | **block** |
| Claim + a receipt that will not parse | **block**, saying so |

A receipt counts as cited if the message contains inline JSON with `"schema":
"guessless.receipt/v1"`, or names a `*.receipt.json` path that exists and parses. Receipt bodies are
excluded from claim and acknowledgement scanning, so a receipt cannot vouch for itself by containing
the word `unresolved`.

Blocking is `exit 2` with the reason on stderr, which Claude Code feeds back to the agent as
actionable text.

**The gate fails open on purpose.** An unreadable transcript, malformed stdin, a missing file, or a
bug inside the gate all allow the stop. It also never blocks twice in a row (`stop_hook_active`),
so it cannot trap a session in a loop. A gate that blocks for reasons the agent cannot act on gets
deleted within a week, and then nothing is gated at all.

It also does **no** cryptography — it checks that a receipt was cited and that the receipt's own
state supports the claim. Verifying that the receipt is genuine is layer 4's job.

### Testing the gate without an agent

```bash
# exits 0 — nothing claimed
node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs --check /dev/null

# exits 2 — unpriced claim, reason on stderr
echo 'I renamed it and updated all call sites.' > claim.txt
node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs --check claim.txt

# exits 0 — same claim, now priced
node /Users/jacksm5pro/dev/open-source/guessless/scripts/claim-gate.mjs \
  --check claim.txt --receipt answer.receipt.json
```

`--json` prints `{"decision":"block","reason":"..."}` instead of prose, for wiring into other tools.
`--cwd <dir>` sets the base directory for resolving `*.receipt.json` references.

The claim vocabulary lives in one exported array, `COMPLETENESS_CLAIM_PATTERNS` at the top of
`scripts/claim-gate.mjs`, and is meant to be extended for your codebase's idioms. The one rule:
only add a phrase that is *false when a single call site is missed*. Phrases that merely sound
confident are not completeness claims, and every false positive spends credibility the gate needs.

---

## Layer 4 — CI

The hook checks that a receipt was *cited*. CI checks that it is *true*.

`scripts/reproduce-check.mjs` walks a tree for `*.receipt.json` files, and for each one re-runs the
query through the built guessless CLI against the sources recorded in the sibling
`*.reproduction.json`. The canonical form must come back byte-identical. A hand-edited integrity
hash, a trimmed result list, or drifted inputs all fail here.

```yaml
- name: Verify guessless receipts
  run: |
    node "$GUESSLESS/scripts/reproduce-check.mjs" docs/ evidence/
  env:
    GUESSLESS: ${{ github.workspace }}/guessless
```

Run `pnpm build` in the guessless checkout first; the check needs `packages/cli/dist/cli.js` and
exits 2 with an explanatory message if it is missing.

| Flag | Effect |
| --- | --- |
| *(none)* | Walks the working directory |
| `<paths...>` | Directories to walk, or individual `*.receipt.json` / `*.reproduction.json` files |
| `--allow-unverifiable` | A receipt with no reproduction bundle is reported but does not fail the run |
| `--quiet` | Only print failures and the summary line |

Exit codes: `0` everything reproduced, `1` something did not (including unverifiable receipts,
unless `--allow-unverifiable`), `2` the checker could not run.

A `*.receipt.json` with no sibling `*.reproduction.json` fails by default. This is the point: a
receipt nobody can re-run is a screenshot, not evidence.

### Recording a bundle

```bash
node "$GUESSLESS/packages/cli/dist/cli.js" query envelope.json > rename.receipt.json
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const inputs = JSON.parse(readFileSync("envelope.json", "utf8")).inputs;
  const receipt = JSON.parse(readFileSync("rename.receipt.json", "utf8"));
  writeFileSync("rename.reproduction.json", JSON.stringify({ inputs, receipt }, null, 2));
'
```

Commit both files. The reproduction bundle carries the sources, so the check keeps working after the
repository moves on from the state the receipt was recorded against.

---

## Adoption facts: what is actually measured

Install the layers with your eyes open. The measurements below are from this repository's own
evidence and none of them flatter the tool.

**Merely making guessless available does not get it used.**

- Real-agent paired benchmark v1: the treatment arm's only difference from control was the MCP
  server entry, with no mention of the tool in any prompt. Guessless was selected in **0 of 5**
  model-backed treatment cells — `"unforcedGuessless": {"eligibleTreatmentCells": 5,
  "selectedCells": 0, "successfulCalls": 0, "selectionRate": 0}`
  ([`aggregate.json`](evidence/guessless-real-agent-benchmark-v1/aggregate.json)). That batch was
  rejected as decision-grade for other reasons (three cells never reached the model), so read the
  zero as an observation, not a verdict.
- An earlier 36-cell synthetic batch whose system instruction never named the tool recorded the same
  thing at larger N: "18 treatment reasons also lacked a Guessless invocation"
  ([`oracle-part-3-v3-attempt.md`](evidence/oracle-part-3-v3-attempt.md)). That batch is quarantined
  as invalid for unrelated reasons and must not be used for an adoption decision — again, an
  observation only.

Both numbers point the same way, and neither is the preregistered natural-discovery trial (which
targets ≥ 80% unforced correct selection and **has never been run**). So the defensible statement is:
*wherever cold availability has been observed, voluntary selection was zero* — not that a rigorous
0% has been established against the bar.

**Naming the tool in the prompt is what moved the number.**

- A neutral optional onboarding card produced 5/5 then 4/6 selection — an explanation helps, but does
  not compel.
- An explicit "you MUST invoke at least one Guessless tool" instruction produced 83 and 68 treatment
  calls versus zero control calls.

**Invocation is still not use.** All 68 of those v5 calls were cancelled client-side and delivered no
engine output ([`guessless-must-have-strategy.md`](research/guessless-must-have-strategy.md)). Even
in the runs where receipts did arrive, *material pre-edit structural use* was 0 of 5 and 0 of 6
cells. An agent can call the tool, receive a correct receipt, and then edit as though it had not.

**Nothing in this repository has measured hooks, CI, skills, or an `AGENTS.md` mention as adoption
channels.** Layers 3 and 4 are argued for, not evidenced: they are the only two that do not depend on
the agent choosing anything, because a hook runs whether or not the agent thought of it and CI runs
whether or not the agent is still in the room. Treat that as the design rationale it is.

The practical consequence: **if you install only layers 1 and 2, expect nothing to change.** The
cheapest configuration with a demonstrable effect is layer 4 alone — CI verification of committed
receipts needs no agent in the loop at all, which is exactly the adoption the v1 verdict identified
as having "the clearest payoff"
([`verdict.md`](evidence/adoption-eval-fable-v1/verdict.md)). Add layer 3 when you want the
correction to arrive while the agent can still act on it, and layers 1 and 2 to make complying
cheap once something is actually asking the agent to comply.
