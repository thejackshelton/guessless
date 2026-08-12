import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { evaluateMessage, extractLastAssistantText, findClaims } from './claim-gate.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const gatePath = join(rootDir, 'scripts/claim-gate.mjs');
const reproduceCheckPath = join(rootDir, 'scripts/reproduce-check.mjs');
const cliPath = join(rootDir, 'packages/cli/dist/cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'guessless-claim-gate-'));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * Minimal receipt bodies. The gate parses receipts, it does not verify them — integrity is
 * reproduce-check's job — so these hand-written shapes exercise exactly what the gate reads.
 */
const completeReceipt = {
	schema: 'guessless.receipt/v1',
	state: 'complete',
	query: 'referencesOf',
	results: [{ file: 'a.ts' }, { file: 'b.ts' }],
};
const partialReceipt = {
	schema: 'guessless.receipt/v1',
	state: 'partial',
	query: 'referencesOf',
	results: [{ file: 'a.ts' }],
	unresolved: [{ reason: 'dynamic-access', file: 'b.ts' }, { reason: 'unresolved-specifier' }],
};
const refusedReceipt = {
	schema: 'guessless.receipt/v1',
	state: 'refused',
	query: 'referencesOf',
	results: [],
	reason: 'unsupported-language',
	detail: 'file is not JavaScript or TypeScript',
};

/**
 * @param {unknown} receipt
 * @returns {string}
 */
function fenced(receipt) {
	return ['```json', JSON.stringify(receipt, null, 2), '```'].join('\n');
}

/**
 * @param {string} message
 * @returns {{ decision: string, reason: string }}
 */
function evaluate(message) {
	const result = evaluateMessage(message, { baseDirs: [scratch] });
	return { decision: result.decision, reason: result.reason };
}

describe('claim detection', () => {
	test('an unreceipted completeness claim is blocked', () => {
		const result = evaluate('I renamed the symbol and updated all call sites.');
		expect(result.decision).toBe('block');
		expect(result.reason).toContain('all call sites');
		expect(result.reason).toContain('guessless receipt');
		expect(result.reason).toMatch(/qualify the claim/i);
	});

	test('a message with no completeness claim is allowed', () => {
		const messages = [
			'I updated the three call sites in src/app.ts, src/api.ts and src/cli.ts.',
			'Added a test for the new helper. Nothing else changed.',
			'The build passes and the types check.',
		];
		for (const message of messages) {
			expect(findClaims(message)).toHaveLength(0);
			expect(evaluate(message).decision).toBe('allow');
		}
	});

	test('hedged phrasing is not a claim and is never blocked', () => {
		const hedged = [
			'I did not check all call sites — grep only covers static imports.',
			'This may not cover every caller; dynamic access would be invisible to me.',
			'I think all references are updated, but I have not proven it.',
			'Should I check whether there are no other usages?',
			'It is probably safe to delete, though I cannot show that.',
		];
		for (const message of hedged) {
			expect(findClaims(message)).toHaveLength(0);
			expect(evaluate(message).decision).toBe('allow');
		}
	});

	test('the phrase list covers the documented claim vocabulary', () => {
		const claims = [
			'Updated all call sites.',
			'Every caller has been renamed.',
			'There are no other usages of this helper.',
			'Nothing else imports it.',
			'The old export is safe to delete.',
			'That was the only reference.',
		];
		for (const message of claims) {
			expect(findClaims(message).length).toBeGreaterThan(0);
			expect(evaluate(message).decision).toBe('block');
		}
	});
});

describe('receipt consistency', () => {
	test('a claim backed by a complete receipt is allowed', () => {
		const message = `Renamed \`target\`. All call sites are updated:\n\n${fenced(completeReceipt)}`;
		expect(evaluate(message).decision).toBe('allow');
	});

	test('a bald claim backed by a partial receipt is blocked, quoting the unresolved count', () => {
		const message = `Renamed \`target\`. All call sites are updated:\n\n${fenced(partialReceipt)}`;
		const result = evaluate(message);
		expect(result.decision).toBe('block');
		expect(result.reason).toContain('partial');
		expect(result.reason).toContain('2 unresolved sites');
	});

	test('a partial receipt with acknowledged gaps is allowed', () => {
		const message = [
			'I updated all call sites the engine could resolve.',
			'The receipt is partial: 2 unresolved sites remain (a dynamic access in b.ts and an',
			'unresolved specifier), and I have not touched those.',
			'',
			fenced(partialReceipt),
		].join('\n');
		expect(evaluate(message).decision).toBe('allow');
	});

	test('a refused receipt cannot support a completeness claim', () => {
		const message = `Nothing else imports it.\n\n${fenced(refusedReceipt)}`;
		const result = evaluate(message);
		expect(result.decision).toBe('block');
		expect(result.reason).toContain('refused');
		expect(result.reason).toContain('unsupported-language');
	});

	test('a malformed receipt blocks with a parse complaint', () => {
		const truncated = JSON.stringify(completeReceipt).slice(0, -12);
		const message = `Updated all call sites.\n\n\`\`\`json\n${truncated}\n\`\`\``;
		const result = evaluate(message);
		expect(result.decision).toBe('block');
		expect(result.reason).toMatch(/did not parse/i);
	});

	test('a receipt referenced by path is loaded from disk', () => {
		writeFileSync(join(scratch, 'rename.receipt.json'), JSON.stringify(completeReceipt));
		writeFileSync(join(scratch, 'broken.receipt.json'), '{"schema": "guessless.receipt/v1"');
		expect(evaluate('Updated all call sites; see rename.receipt.json.').decision).toBe('allow');

		const broken = evaluate('Updated all call sites; see broken.receipt.json.');
		expect(broken.decision).toBe('block');
		expect(broken.reason).toMatch(/did not parse/i);

		const missing = evaluate('Updated all call sites; see absent.receipt.json.');
		expect(missing.decision).toBe('block');
		expect(missing.reason).toMatch(/no guessless receipt/i);
	});
});

describe('transcript mode', () => {
	/**
	 * @param {readonly unknown[]} entries
	 * @returns {string}
	 */
	function transcript(entries) {
		return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
	}

	const conversation = [
		{ type: 'user', message: { role: 'user', content: 'rename target' } },
		{
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the file.' }] },
		},
		{
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Done. I updated all call sites.' }],
			},
		},
		{
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
			},
		},
	];

	test('extracts the last assistant message that carries text', () => {
		expect(extractLastAssistantText(transcript(conversation))).toBe(
			'Done. I updated all call sites.',
		);
	});

	test('tolerates a half-written trailing line and non-JSON noise', () => {
		const raw = `${transcript(conversation)}{"type":"assistant","mess`;
		expect(extractLastAssistantText(raw)).toBe('Done. I updated all call sites.');
		expect(extractLastAssistantText('')).toBe('');
		expect(extractLastAssistantText('not json at all\n')).toBe('');
	});

	/**
	 * @param {string} payload
	 * @returns {{ status: number | null, stdout: string, stderr: string }}
	 */
	function runHook(payload) {
		const result = spawnSync(process.execPath, [gatePath], {
			input: payload,
			encoding: 'utf8',
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	test('the Stop hook blocks with exit 2 and an actionable stderr reason', () => {
		const transcriptPath = join(scratch, 'session.jsonl');
		writeFileSync(transcriptPath, transcript(conversation));
		const result = runHook(
			JSON.stringify({
				session_id: 'abc',
				transcript_path: transcriptPath,
				cwd: scratch,
				hook_event_name: 'Stop',
				stop_hook_active: false,
			}),
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('all call sites');
		expect(result.stdout).toBe('');
	});

	test('the Stop hook allows a receipted transcript', () => {
		const transcriptPath = join(scratch, 'receipted.jsonl');
		writeFileSync(
			transcriptPath,
			transcript([
				{
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: `Updated all call sites.\n${JSON.stringify(completeReceipt)}`,
							},
						],
					},
				},
			]),
		);
		const result = runHook(
			JSON.stringify({ transcript_path: transcriptPath, hook_event_name: 'Stop' }),
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
	});

	test('the hook fails open on unusable input and never loops on itself', () => {
		expect(runHook('not json').status).toBe(0);
		expect(runHook(JSON.stringify({ transcript_path: '/nope/missing.jsonl' })).status).toBe(0);

		const transcriptPath = join(scratch, 'session.jsonl');
		const looping = runHook(
			JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: true }),
		);
		expect(looping.status).toBe(0);
	});
});

describe('--check mode', () => {
	/**
	 * @param {readonly string[]} argv
	 * @returns {{ status: number | null, stdout: string, stderr: string }}
	 */
	function runCheck(argv) {
		const result = spawnSync(process.execPath, [gatePath, ...argv], { encoding: 'utf8' });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	test('an empty file allows, matching the packaged smoke check', () => {
		expect(runCheck(['--check', '/dev/null']).status).toBe(0);
	});

	test('a claim file blocks and a --receipt argument prices it', () => {
		const claimPath = join(scratch, 'claim.txt');
		const receiptPath = join(scratch, 'explicit.receipt.json');
		writeFileSync(claimPath, 'I renamed it and updated all call sites.\n');
		writeFileSync(receiptPath, JSON.stringify(completeReceipt));

		const bare = runCheck(['--check', claimPath, '--json']);
		expect(bare.status).toBe(2);
		expect(JSON.parse(bare.stdout).decision).toBe('block');

		const priced = runCheck(['--check', claimPath, '--receipt', receiptPath, '--json']);
		expect(priced.status).toBe(0);
		expect(JSON.parse(priced.stdout).decision).toBe('allow');
	});

	test('--receipt pointing at a refused receipt still blocks', () => {
		const claimPath = join(scratch, 'claim.txt');
		const receiptPath = join(scratch, 'refused.receipt.json');
		writeFileSync(receiptPath, JSON.stringify(refusedReceipt));
		const result = runCheck(['--check', claimPath, '--receipt', receiptPath]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('refused');
	});
});

describe('reproduce-check', () => {
	const bundleDir = join(scratch, 'bundles');
	const inputs = [
		{ path: 'source.ts', source: 'export const alpha = 1;\nexport function beta() {}\n' },
	];
	const request = { kind: 'exportedNames', file: 'source.ts' };

	beforeAll(() => {
		execFileSync('pnpm', ['build'], { cwd: rootDir, stdio: 'ignore' });
		writeFileSync(join(scratch, 'query.json'), JSON.stringify({ inputs, request }));
	});

	/**
	 * Produce a genuine receipt with the built CLI — nothing here is hand-written, so a tamper test
	 * against it is a real integrity failure rather than a fixture disagreement.
	 *
	 * @param {string} directory
	 * @param {string} name
	 * @returns {{ receiptPath: string, bundlePath: string }}
	 */
	function record(directory, name) {
		mkdirSync(directory, { recursive: true });
		const queryPath = join(scratch, 'query.json');
		const stdout = execFileSync(process.execPath, [cliPath, 'query', queryPath], {
			encoding: 'utf8',
		});
		const receipt = JSON.parse(stdout);
		expect(receipt.state).toBe('complete');
		const receiptPath = join(directory, `${name}.receipt.json`);
		const bundlePath = join(directory, `${name}.reproduction.json`);
		writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
		writeFileSync(bundlePath, JSON.stringify({ inputs, receipt }, null, 2));
		return { receiptPath, bundlePath };
	}

	/**
	 * @param {readonly string[]} argv
	 * @returns {{ status: number | null, stdout: string, stderr: string }}
	 */
	function runCheck(argv) {
		const result = spawnSync(process.execPath, [reproduceCheckPath, ...argv], {
			encoding: 'utf8',
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	test('a real bundle reproduces', () => {
		const directory = join(bundleDir, 'good');
		record(directory, 'exports');
		const result = runCheck([directory]);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('1 reproduced, 0 failed, 0 unverifiable');
	});

	test('flipping one byte of a recorded receipt fails the check', () => {
		const directory = join(bundleDir, 'tampered');
		const { receiptPath, bundlePath } = record(directory, 'exports');
		const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
		const integrity = bundle.receipt.integrity;
		const flipped = integrity.slice(0, -1) + (integrity.endsWith('a') ? 'b' : 'a');
		expect(flipped).not.toBe(integrity);
		bundle.receipt.integrity = flipped;
		writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
		writeFileSync(receiptPath, JSON.stringify(bundle.receipt, null, 2));

		const result = runCheck([directory]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('FAILED');
		expect(result.stderr).toContain('0 reproduced, 1 failed');
	});

	test('a receipt with no reproduction bundle is unverifiable', () => {
		const directory = join(bundleDir, 'orphan');
		const { bundlePath } = record(directory, 'exports');
		rmSync(bundlePath);

		const strict = runCheck([directory]);
		expect(strict.status).toBe(1);
		expect(strict.stderr).toContain('unverifiable');

		const lenient = runCheck([directory, '--allow-unverifiable']);
		expect(lenient.status).toBe(0);
		expect(lenient.stdout).toContain('1 unverifiable');
	});

	test('--help works and an empty tree is not a failure', () => {
		const help = runCheck(['--help']);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('reproduce-check');

		const empty = join(bundleDir, 'empty');
		mkdirSync(empty, { recursive: true });
		const result = runCheck([empty]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('no *.receipt.json files found');
	});
});
