#!/usr/bin/env node
/**
 * guessless claim gate — a Claude Code `Stop` hook adapter.
 *
 * The gate exists for one narrow job: stop an agent from ending a turn on an *unpriced structural
 * completeness claim* about JavaScript/TypeScript code ("I renamed all call sites", "nothing else
 * imports it", "safe to delete"). Those are exactly the claims guessless can price, and exactly the
 * claims a language model has no way to know it is entitled to make.
 *
 * Design rules, in priority order:
 *
 *   1. Fail open. Only completeness claims are gated. No claim, an unreadable transcript, a broken
 *      pipe, a bug in this file — every one of those allows the stop. A gate that blocks for reasons
 *      the agent cannot act on gets deleted within the week, and then nothing is gated at all.
 *   2. Never cry wolf. Hedged prose ("I did not check every caller", "this may miss usages") is not
 *      a claim; a claim is an unqualified assertion of completeness. Sentence-scoped hedge detection
 *      (see `HEDGE_PATTERNS`) keeps qualified answers out of the gate.
 *   3. Price what is claimed. A claim backed by a `complete` receipt passes. A claim backed by a
 *      `partial` receipt passes only if the prose admits the gap. A claim backed by a `refused`
 *      receipt never passes.
 *
 * Integrity is deliberately *not* verified here — this gate only parses. Cryptographic verification
 * of a receipt against its inputs is what `scripts/reproduce-check.mjs` does in CI, where the engine
 * is built and a wrong answer can be made to fail a pipeline rather than nag a developer.
 *
 * ## Hook mode (default, no arguments)
 *
 * Claude Code runs `Stop` hooks with a single JSON object on stdin (`session_id`, `cwd`,
 * `transcript_path`, `hook_event_name`, `stop_hook_active`). We read the last assistant message out
 * of the JSONL transcript at `transcript_path` and evaluate it.
 *
 *   - allow: exit 0, no output.
 *   - block: exit 2 with the reason on stderr (Claude Code feeds stderr back to the agent). The
 *     equivalent `{"decision":"block","reason":"..."}` stdout form is available via `--json`.
 *
 * `stop_hook_active: true` means Claude is already continuing *because* a stop hook blocked it.
 * Blocking again there risks an unbounded loop, so that case always allows.
 *
 * ## Check mode (`--check <file> [--receipt <path>] [--cwd <dir>] [--json]`)
 *
 * Reads a plain-text claim from a file and runs the identical core logic. This is the CI and test
 * entry point; exit 0 allows, exit 2 blocks.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT_SCHEMA = 'guessless.receipt/v1';

/**
 * Structural completeness claims, as regular expressions matched case-insensitively against the
 * agent's final message.
 *
 * Extend this list freely — it is the one place the gate's vocabulary lives. Two rules for new
 * entries: anchor both ends on word boundaries (`\b`) so substrings of ordinary prose cannot match,
 * and only add a phrase that is *false when a single call site is missed*. Phrases that merely sound
 * confident ("this looks right", "should be fine") are not completeness claims and must not be
 * added; the gate's usefulness is entirely a function of its false-positive rate.
 *
 * @type {readonly RegExp[]}
 */
export const COMPLETENESS_CLAIM_PATTERNS = [
	// "all call sites", "all of the call-sites", "all remaining references"
	/\ball (?:of )?(?:the )?(?:other |remaining |existing )?(?:call[ -]?sites?|references?|usages?|callers?|imports?|importers?|consumers?|occurrences?)\b/,
	// "every caller", "every usage renamed"
	/\bevery (?:other |remaining |existing )?(?:call[ -]?site|reference|usage|caller|import|importer|consumer|occurrence)s?\b/,
	// "no other usages", "no remaining references", "there are no callers"
	/\bno (?:other |remaining |further |additional )?(?:call[ -]?sites?|references?|usages?|callers?|imports?|importers?|consumers?)\b/,
	// "nothing else imports it", "no one else uses this"
	/\b(?:nothing|no one|nobody|no other (?:file|module|package)s?) (?:else )?(?:imports?|uses?|references?|calls?|depends on)\b/,
	// "safe to delete", "safe to remove"
	/\bsafe to (?:delete|remove|drop|inline|rename)\b/,
	// "the only call site", "the only remaining reference"
	/\bonly (?:remaining )?(?:call[ -]?site|reference|usage|caller)s?\b/,
	// "fully renamed", "completely migrated"
	/\b(?:fully|completely|exhaustively) (?:renamed|updated|migrated|removed|deleted|replaced|covered)\b/,
	// "it is now unused", "this symbol is dead code"
	/\b(?:is|are)(?: now)? (?:unused|dead code|unreferenced|orphaned)\b/,
	// "checked every file", "searched all modules"
	/\b(?:checked|searched|scanned|verified|updated|renamed|migrated|swept) (?:all|every) (?:of )?(?:the )?(?:files?|modules?|packages?|places?|instances?)\b/,
	// "nothing left to update", "no more places to change"
	/\b(?:no more|nothing (?:more|left)) (?:places? )?to (?:update|rename|change|fix|migrate)\b/,
];

/**
 * Hedges. If any of these appears in the *same sentence* as a completeness phrase, the sentence is
 * a qualified statement rather than a claim, and the gate stays out of the way.
 *
 * @type {readonly RegExp[]}
 */
export const HEDGE_PATTERNS = [
	/\b(?:not|never|cannot|unable|unsure|unclear|unverified|unchecked)\b/,
	/n['’]t\b/,
	/\b(?:may|might|could|possibly|perhaps|probably|likely|presumably)\b/,
	/\b(?:assume|assumed|assuming|believe|think|thought|suspect|guess)\b/,
	/\b(?:appears?|appeared|seems?|seemed|looks? like)\b/,
	/\b(?:should|would) be\b/,
	/\bwithout (?:checking|verifying|running|proving)\b/,
	/\b(?:did|do|does|have|has|is|are|was|were|will|would|should|could|can|may|might)\s+you\b/,
	/\?\s*$/,
];

/**
 * Phrases that count as owning up to a `partial` receipt's gaps.
 *
 * @type {readonly RegExp[]}
 */
export const GAP_ACKNOWLEDGEMENT_PATTERNS = [
	/\bpartial(?:ly)?\b/,
	/\bunresolved\b/,
	/\bexcept\b/,
	/\bgaps?\b/,
];

/* -------------------------------------------------------------------------------------------- */
/* Claim detection                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Split text into rough sentences, keeping offsets so a match can be mapped back to its sentence.
 *
 * @param {string} text
 * @returns {{ start: number, end: number, text: string }[]}
 */
function sentencesOf(text) {
	/** @type {{ start: number, end: number, text: string }[]} */
	const sentences = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		const isTerminator = character === '\n' || character === '.' || character === '!';
		const isQuestion = character === '?';
		if (!isTerminator && !isQuestion) continue;
		// Keep "?" inside the sentence so the trailing-question hedge can see it.
		const end = isQuestion ? index + 1 : index;
		sentences.push({ start, end, text: text.slice(start, end) });
		start = index + 1;
	}
	if (start < text.length) sentences.push({ start, end: text.length, text: text.slice(start) });
	return sentences;
}

/**
 * @param {string} sentence
 * @returns {boolean}
 */
function isHedged(sentence) {
	return HEDGE_PATTERNS.some((pattern) => new RegExp(pattern.source, 'i').test(sentence));
}

/**
 * Find every unhedged structural completeness claim in a message.
 *
 * @param {string} message
 * @returns {{ phrase: string, sentence: string }[]}
 */
export function findClaims(message) {
	if (typeof message !== 'string' || message.trim() === '') return [];
	const sentences = sentencesOf(message);
	/** @type {{ phrase: string, sentence: string }[]} */
	const claims = [];
	for (const sentence of sentences) {
		if (isHedged(sentence.text)) continue;
		for (const pattern of COMPLETENESS_CLAIM_PATTERNS) {
			const match = new RegExp(pattern.source, 'i').exec(sentence.text);
			if (match === null) continue;
			claims.push({ phrase: match[0].trim(), sentence: sentence.text.trim() });
		}
	}
	return claims;
}

/* -------------------------------------------------------------------------------------------- */
/* Receipt discovery                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Depth-first search for the first embedded guessless receipt inside an arbitrary parsed value.
 * Receipts arrive wrapped as often as they arrive bare — inside a reproduction bundle, inside an
 * MCP tool result, inside a `{ "receipt": ... }` envelope — so unwrapping is the common case.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function findEmbeddedReceipt(value) {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findEmbeddedReceipt(item);
			if (found !== null) return found;
		}
		return null;
	}
	if (!isRecord(value)) return null;
	if (value.schema === RECEIPT_SCHEMA) return value;
	for (const nested of Object.values(value)) {
		const found = findEmbeddedReceipt(nested);
		if (found !== null) return found;
	}
	return null;
}

/**
 * Extract the balanced JSON object beginning at `start`, honouring string literals and escapes.
 *
 * @param {string} text
 * @param {number} start
 * @returns {string | null}
 */
function balancedObjectAt(text, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === '{') depth += 1;
		else if (character === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * Pull every inline receipt out of a message. Returns both the receipts that parsed and a flag for
 * receipt-shaped text that refused to parse — a truncated or hand-edited receipt is a *stronger*
 * signal that something is wrong than no receipt at all, so it must not be silently ignored.
 *
 * @param {string} message
 * @returns {{ receipts: Record<string, unknown>[], malformed: string[] }}
 */
function inlineReceipts(message) {
	/** @type {Record<string, unknown>[]} */
	const receipts = [];
	/** @type {string[]} */
	const malformed = [];
	const marker = new RegExp(RECEIPT_SCHEMA.replace(/[.[\]{}()*+?^$|\\/]/g, '\\$&'), 'g');
	const seen = new Set();
	for (const match of message.matchAll(marker)) {
		const markerIndex = match.index ?? 0;
		let parsed = null;
		// Walk outward from the marker: the outermost object that both contains the marker and
		// parses wins, so a receipt nested in a wrapper is recovered together with its wrapper
		// rather than truncated at the receipt's own opening brace.
		for (let index = 0; index <= markerIndex; index += 1) {
			if (message[index] !== '{') continue;
			const candidate = balancedObjectAt(message, index);
			if (candidate === null) continue;
			if (index + candidate.length <= markerIndex) continue;
			try {
				parsed = { start: index, value: JSON.parse(candidate) };
				break;
			} catch {
				continue;
			}
		}
		if (parsed === null) {
			malformed.push('an inline receipt block that is not valid JSON');
			continue;
		}
		if (seen.has(parsed.start)) continue;
		seen.add(parsed.start);
		const receipt = findEmbeddedReceipt(parsed.value);
		if (receipt === null) malformed.push('an inline receipt block that is not valid JSON');
		else receipts.push(receipt);
	}
	return { receipts, malformed };
}

/**
 * Resolve a `*.receipt.json` path mentioned in prose against the directories we know about.
 *
 * @param {string} candidate
 * @param {readonly string[]} baseDirs
 * @returns {string | null}
 */
function resolveReceiptPath(candidate, baseDirs) {
	const cleaned = candidate.replace(/^[.][/\\]/, '');
	const roots = isAbsolute(candidate) ? [''] : baseDirs;
	for (const base of roots) {
		const full = isAbsolute(candidate) ? candidate : resolve(base, cleaned);
		try {
			if (existsSync(full) && statSync(full).isFile()) return full;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Pull every referenced `*.receipt.json` file out of a message and load it.
 *
 * @param {string} message
 * @param {readonly string[]} baseDirs
 * @returns {{ receipts: Record<string, unknown>[], malformed: string[] }}
 */
function referencedReceipts(message, baseDirs) {
	/** @type {Record<string, unknown>[]} */
	const receipts = [];
	/** @type {string[]} */
	const malformed = [];
	const pattern = /[^\s"'`()[\]<>,;]*[^\s"'`()[\]<>,;.]\.receipt\.json\b/g;
	const seen = new Set();
	for (const match of message.matchAll(pattern)) {
		const mentioned = match[0];
		if (seen.has(mentioned)) continue;
		seen.add(mentioned);
		const path = resolveReceiptPath(mentioned, baseDirs);
		// A path that does not exist is not a cited receipt; it falls through to "no receipt", which
		// already tells the agent to attach one.
		if (path === null) continue;
		let value;
		try {
			value = JSON.parse(readFileSync(path, 'utf8'));
		} catch {
			malformed.push(`${mentioned} (not valid JSON)`);
			continue;
		}
		const receipt = findEmbeddedReceipt(value);
		if (receipt === null) malformed.push(`${mentioned} (no guessless receipt inside)`);
		else receipts.push(receipt);
	}
	return { receipts, malformed };
}

/**
 * Strip cited evidence — fenced code blocks and any balanced JSON object containing a receipt —
 * leaving only the agent's own prose.
 *
 * This separation is load-bearing in both directions. A receipt body contains the words the gate
 * looks for: `"unresolved"` appears in every partial receipt, so scanning the raw message for a
 * gap acknowledgement would let a receipt vouch for itself and every partial receipt would pass.
 * Symmetrically, `"reason": "no-other-references"` inside a receipt is not the agent claiming
 * anything. Claims and acknowledgements are things the agent says; receipts are evidence it pastes.
 *
 * @param {string} message
 * @returns {string}
 */
export function proseOf(message) {
	const text = message.replace(/```[\s\S]*?```/g, ' ');
	let prose = '';
	let cursor = 0;
	while (cursor < text.length) {
		const markerAt = text.indexOf(RECEIPT_SCHEMA, cursor);
		if (markerAt === -1) {
			prose += text.slice(cursor);
			break;
		}
		let removed = false;
		for (let index = cursor; index <= markerAt; index += 1) {
			if (text[index] !== '{') continue;
			const candidate = balancedObjectAt(text, index);
			if (candidate === null) continue;
			if (index + candidate.length <= markerAt) continue;
			prose += text.slice(cursor, index);
			cursor = index + candidate.length;
			removed = true;
			break;
		}
		if (removed) continue;
		// Receipt-shaped text we could not delimit (truncated JSON): drop just the marker so the
		// schema string itself cannot be read as prose, and carry on.
		prose += text.slice(cursor, markerAt);
		cursor = markerAt + RECEIPT_SCHEMA.length;
	}
	return prose;
}

/**
 * Every receipt cited by a message, from inline JSON and from referenced files.
 *
 * @param {string} message
 * @param {readonly string[]} baseDirs
 * @returns {{ receipts: Record<string, unknown>[], malformed: string[] }}
 */
export function collectReceipts(message, baseDirs = [process.cwd()]) {
	const inline = inlineReceipts(message);
	const referenced = referencedReceipts(message, baseDirs);
	return {
		receipts: [...inline.receipts, ...referenced.receipts],
		malformed: [...inline.malformed, ...referenced.malformed],
	};
}

/* -------------------------------------------------------------------------------------------- */
/* Receipt reading                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * @param {Record<string, unknown>} receipt
 * @returns {'complete' | 'partial' | 'refused' | null}
 */
function receiptState(receipt) {
	const state = receipt.state;
	if (state === 'complete' || state === 'partial' || state === 'refused') return state;
	return null;
}

/**
 * @param {Record<string, unknown>} receipt
 * @returns {number}
 */
function unresolvedCount(receipt) {
	return Array.isArray(receipt.unresolved) ? receipt.unresolved.length : 0;
}

/**
 * A `partial` receipt is honest about its own gaps; the prose has to be too.
 *
 * @param {string} message
 * @param {Record<string, unknown>} receipt
 * @returns {boolean}
 */
export function acknowledgesGaps(message, receipt) {
	if (
		GAP_ACKNOWLEDGEMENT_PATTERNS.some((pattern) =>
			new RegExp(pattern.source, 'i').test(message),
		)
	)
		return true;
	const count = unresolvedCount(receipt);
	return count > 0 && new RegExp(`\\b${count}\\b`).test(message);
}

/* -------------------------------------------------------------------------------------------- */
/* The gate                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} GateDecision
 * @property {'allow' | 'block'} decision
 * @property {string} reason Empty when allowing.
 * @property {{ phrase: string, sentence: string }[]} claims
 */

const ATTACH_OR_QUALIFY =
	'Either attach a guessless receipt proving it — inline JSON with ' +
	`"schema": "${RECEIPT_SCHEMA}", or the path to a *.receipt.json file — or qualify the claim: ` +
	'say which sites you actually checked instead of saying "all".';

/**
 * Evaluate one final message. This is the whole gate; both entry points call it.
 *
 * @param {string} message
 * @param {{ baseDirs?: readonly string[] }} [options]
 * @returns {GateDecision}
 */
export function evaluateMessage(message, options = {}) {
	const baseDirs = options.baseDirs ?? [process.cwd()];
	const prose = proseOf(message);
	const claims = findClaims(prose);
	if (claims.length === 0) return { decision: 'allow', reason: '', claims };

	const quoted = [...new Set(claims.map((claim) => `"${claim.phrase}"`))].slice(0, 3).join(', ');
	const { receipts, malformed } = collectReceipts(message, baseDirs);

	if (receipts.length === 0) {
		if (malformed.length > 0)
			return {
				decision: 'block',
				claims,
				reason:
					`guessless claim gate: this message claims structural completeness (${quoted}) ` +
					`and cites ${malformed[0]}, but that receipt did not parse, so the claim is ` +
					`unpriced. Re-run the guessless query and paste the receipt verbatim, or ` +
					`qualify the claim: say which sites you actually checked instead of "all".`,
			};
		return {
			decision: 'block',
			claims,
			reason:
				`guessless claim gate: this message claims structural completeness (${quoted}) ` +
				`with no guessless receipt behind it. A grep cannot see re-exports, aliases, or ` +
				`dynamic access, so "all" here is a guess. ${ATTACH_OR_QUALIFY}`,
		};
	}

	if (receipts.some((receipt) => receiptState(receipt) === 'complete'))
		return { decision: 'allow', reason: '', claims };

	const unreadable = receipts.find((receipt) => receiptState(receipt) === null);
	if (unreadable !== undefined)
		return {
			decision: 'block',
			claims,
			reason:
				`guessless claim gate: this message claims structural completeness (${quoted}) and ` +
				`cites a receipt, but that receipt did not parse as a guessless receipt — its ` +
				`"state" is missing or is not one of complete/partial/refused. Re-run the ` +
				`guessless query and paste the receipt verbatim.`,
		};

	const refused = receipts.find((receipt) => receiptState(receipt) === 'refused');
	if (refused !== undefined) {
		const detail = typeof refused.reason === 'string' ? refused.reason : 'unspecified';
		return {
			decision: 'block',
			claims,
			reason:
				`guessless claim gate: this message claims structural completeness (${quoted}), but ` +
				`the cited receipt is state "refused" (reason: ${detail}). A refusal means the ` +
				`question was never answered, so it cannot support a completeness claim. Resolve ` +
				`the refusal and re-query, or drop the claim.`,
		};
	}

	const partial = receipts.find((receipt) => receiptState(receipt) === 'partial');
	if (partial !== undefined && !acknowledgesGaps(prose, partial)) {
		const count = unresolvedCount(partial);
		const sites = count === 1 ? '1 unresolved site' : `${count} unresolved sites`;
		return {
			decision: 'block',
			claims,
			reason:
				`guessless claim gate: this message claims structural completeness (${quoted}), but ` +
				`the cited receipt is state "partial" with ${sites}. The receipt does not support ` +
				`the word "all". Name the unresolved ${count === 1 ? 'site' : 'sites'} and say the ` +
				`answer is partial, or resolve them and re-query for a complete receipt.`,
		};
	}

	return { decision: 'allow', reason: '', claims };
}

/* -------------------------------------------------------------------------------------------- */
/* Transcript reading                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * Concatenate the text blocks of one transcript entry's message, if it is an assistant message.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function assistantTextOf(entry) {
	if (!isRecord(entry)) return null;
	const message = isRecord(entry.message) ? entry.message : null;
	const role = message?.role ?? entry.role;
	const type = entry.type;
	if (role !== 'assistant' && type !== 'assistant') return null;
	const content = message?.content ?? entry.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	/** @type {string[]} */
	const parts = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'text') continue;
		if (typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('\n');
}

/**
 * Extract the last assistant message's text from a Claude Code JSONL transcript.
 *
 * Walks backwards and returns the most recent assistant entry that carries text: the very last
 * assistant entry is frequently a bare tool call with no prose, and the prose is what makes claims.
 * Unparseable lines are skipped rather than fatal — transcripts are appended to live, so the tail
 * can be a half-written line.
 *
 * @param {string} transcript Raw JSONL contents.
 * @returns {string} Empty string when no assistant text is present.
 */
export function extractLastAssistantText(transcript) {
	const lines = transcript.split('\n');
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (line === '') continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const text = assistantTextOf(entry);
		if (text !== null && text.trim() !== '') return text;
	}
	return '';
}

/* -------------------------------------------------------------------------------------------- */
/* Entry points                                                                                   */
/* -------------------------------------------------------------------------------------------- */

const USAGE = `guessless claim gate

  claim-gate.mjs                      Claude Code Stop hook: reads the hook JSON on stdin.
  claim-gate.mjs --check <file>       Evaluate a plain-text claim from <file>.
      [--receipt <path>]              Use this receipt instead of scanning the text for one.
      [--cwd <dir>]                   Base directory for resolving *.receipt.json references.
      [--json]                        Emit {"decision":...,"reason":...} instead of prose.

Exit codes: 0 allow, 2 block. Hook mode fails open — any internal error allows the stop.
`;

/**
 * @param {readonly string[]} argv
 * @returns {{ check: string | null, receipt: string | null, cwd: string | null, json: boolean, help: boolean }}
 */
function parseArgs(argv) {
	let check = null;
	let receipt = null;
	let cwd = null;
	let json = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') help = true;
		else if (arg === '--json') json = true;
		else if (arg === '--check') check = argv[(index += 1)] ?? null;
		else if (arg === '--receipt') receipt = argv[(index += 1)] ?? null;
		else if (arg === '--cwd') cwd = argv[(index += 1)] ?? null;
		else help = true;
	}
	return { check, receipt, cwd, json, help };
}

/**
 * Fold an explicitly supplied `--receipt` file into the message, so the single evaluation path in
 * `evaluateMessage` stays the only place the gate's rules are written down.
 *
 * @param {string} message
 * @param {string} receiptPath
 * @returns {string}
 */
function withExplicitReceipt(message, receiptPath) {
	let raw;
	try {
		raw = readFileSync(receiptPath, 'utf8');
	} catch {
		return `${message}\n\n${receiptPath}`;
	}
	// Appending the raw bytes preserves malformed-receipt behaviour: a receipt file that does not
	// parse must still register as a cited-but-broken receipt rather than as no receipt at all.
	const marker = raw.includes(RECEIPT_SCHEMA) ? raw : `{"schema":"${RECEIPT_SCHEMA}",${raw}`;
	return `${message}\n\n${marker}`;
}

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
function runCheckMode(argv) {
	const args = parseArgs(argv);
	if (args.help || args.check === null) {
		process.stdout.write(USAGE);
		return args.help && args.check === null ? 0 : 2;
	}
	let message;
	try {
		message = readFileSync(args.check, 'utf8');
	} catch (error) {
		process.stderr.write(`claim-gate: cannot read ${args.check}: ${describe(error)}\n`);
		return 2;
	}
	if (args.receipt !== null) message = withExplicitReceipt(message, args.receipt);
	const baseDirs = [
		...(args.cwd === null ? [] : [resolve(args.cwd)]),
		dirname(resolve(args.check)),
		process.cwd(),
	];
	const result = evaluateMessage(message, { baseDirs });
	if (args.json) {
		process.stdout.write(
			`${JSON.stringify({ decision: result.decision, reason: result.reason })}\n`,
		);
	} else if (result.decision === 'block') {
		process.stderr.write(`${result.reason}\n`);
	} else {
		process.stdout.write('claim-gate: allowed (no unpriced completeness claim)\n');
	}
	return result.decision === 'block' ? 2 : 0;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * @returns {Promise<string>}
 */
async function readStdin() {
	/** @type {Buffer[]} */
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Hook mode. Every failure path here allows the stop: a hook that blocks because it could not read
 * its own input is strictly worse than no hook.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function runHookMode(argv) {
	const wantsJson = argv.includes('--json');
	let payload;
	try {
		payload = JSON.parse(await readStdin());
	} catch {
		return 0;
	}
	if (!isRecord(payload)) return 0;
	// Already continuing because a stop hook blocked: never block twice, or the session can loop.
	if (payload.stop_hook_active === true) return 0;
	const transcriptPath = payload.transcript_path;
	if (typeof transcriptPath !== 'string' || transcriptPath === '') return 0;
	let transcript;
	try {
		transcript = readFileSync(transcriptPath, 'utf8');
	} catch {
		return 0;
	}
	const message = extractLastAssistantText(transcript);
	if (message.trim() === '') return 0;
	const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd();
	const result = evaluateMessage(message, { baseDirs: [cwd, process.cwd()] });
	if (result.decision === 'allow') return 0;
	if (wantsJson) {
		process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
		return 0;
	}
	process.stderr.write(`${result.reason}\n`);
	return 2;
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
	if (argv.includes('--help') || argv.includes('-h')) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (argv.includes('--check')) return runCheckMode(argv);
	try {
		return await runHookMode(argv);
	} catch {
		return 0;
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
