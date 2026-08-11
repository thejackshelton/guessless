import {
	cpSync,
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
	V7_BUDGETS,
	V7_MODEL,
	V7_POLICY,
	V7_TASKS,
	buildV7Order,
	buildV7Prompts,
	sha256,
	stableJson,
	v7FixtureRoot,
} from '../src/v7-contracts.ts';
import { fakeV7Preflight, parseV7Jsonl } from '../src/v7-codex.ts';
import { verifyV7Fixture } from '../src/v7-runner.ts';
import { scoreV7Response, validateV7Response } from '../src/v7-scoring.ts';

interface TestManifest {
	files: { path: string; bytes: number; sha256: string }[];
	externals: { path: string; bytes: number; sha256: string }[];
	predecessors: Record<string, string>;
	integrity: string;
}

function makeWritable(root: string): void {
	const visit = (path: string): void => {
		const directory = lstatSync(path).isDirectory();
		chmodSync(path, directory ? 0o755 : 0o644);
		if (directory) for (const entry of readdirSync(path)) visit(join(path, entry));
	};
	visit(root);
}

describe('oracle part 3 v7 one-shot measurement', () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const root of temporary.splice(0)) {
			makeWritable(root);
			rmSync(root, { recursive: true, force: true });
		}
	});

	function fixtureCopy(): string {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v7-mutation-'));
		temporary.push(root);
		cpSync(v7FixtureRoot(), root, { recursive: true, preserveTimestamps: true });
		return root;
	}

	function resealManifest(root: string, mutation: (manifest: TestManifest) => void): void {
		const path = join(root, 'manifest.json');
		chmodSync(path, 0o644);
		const manifest = JSON.parse(readFileSync(path, 'utf8')) as TestManifest;
		mutation(manifest);
		const { integrity: _integrity, ...unsigned } = manifest;
		manifest.integrity = sha256(stableJson(unsigned));
		writeFileSync(path, stableJson(manifest));
	}

	test('preserves exact tasks, order, model, budgets, and neutral prompts', () => {
		expect(V7_TASKS).toHaveLength(18);
		expect(buildV7Order()).toHaveLength(72);
		expect(buildV7Order().map((cell) => cell.ordinal)).toEqual(
			Array.from({ length: 72 }, (_, index) => index + 1),
		);
		expect(V7_MODEL).toBe('gpt-5.6-sol');
		expect(V7_POLICY).toMatchObject({ retries: 0, replacements: 0, rescoring: false });
		expect(V7_BUDGETS).toMatchObject({
			perCell: { maxToolCalls: 16, maxReportedTokens: 160_000, timeoutMs: 300_000 },
			aggregate: { maxToolCalls: 1_152, maxReportedTokens: 11_520_000 },
		});
		expect(JSON.stringify(buildV7Prompts())).not.toMatch(
			/guessless|oracle|mcp|safe[_ -]?change|prepare[_ -]?snapshot/i,
		);
		expect(verifyV7Fixture()).toMatchObject({ tasks: 18, cells: 72 });
	});

	test('parses real Codex JSONL lifecycle and rejects accounting violations', () => {
		const transcript = [
			{ type: 'thread.started', thread_id: 't' },
			{ type: 'turn.started' },
			{
				type: 'item.started',
				item: {
					id: '1',
					type: 'mcp_tool_call',
					server: 'guessless',
					tool: 'guessless_prepare_snapshot',
				},
			},
			{
				type: 'item.completed',
				item: {
					id: '1',
					type: 'mcp_tool_call',
					server: 'guessless',
					tool: 'guessless_prepare_snapshot',
					status: 'completed',
				},
			},
			{
				type: 'item.completed',
				item: { id: '2', type: 'agent_message', text: '{"schema":"seal"}' },
			},
			{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
		];
		const parsed = parseV7Jsonl(
			transcript.map((event) => JSON.stringify(event)).join('\n'),
			20,
		);
		expect(parsed).toMatchObject({
			accounting: {
				starts: 1,
				deliveredResults: 1,
				deliveredApplicablePrepare: 1,
				reportedTokens: 15,
				durationMs: 20,
			},
			finalText: '{"schema":"seal"}',
		});
		expect(() => parseV7Jsonl('{"type":"turn.completed","usage":{}}\n{}', 1)).toThrow();
	});

	test('has exact fake all-success and first-failure topology', () => {
		const fake = fakeV7Preflight(buildV7Order());
		expect(fake.allSuccess).toMatchObject({ outcome: 'complete' });
		expect(fake.firstFailure).toMatchObject({ outcome: 'partial-NO_GO' });
		expect(fake.spawnedOnFailure).toBe(1);
		expect(fake.unrunOnFailure).toBe(71);
		expect(
			fake.firstFailure.records.filter((record) => record.status === 'unrun'),
		).toHaveLength(71);
	});

	test('validates answers fail closed and scores false completeness', () => {
		expect(() =>
			validateV7Response({ state: 'complete', resolved: [], unresolved: [] }),
		).toThrow();
		const score = scoreV7Response(
			{
				task: { id: 'x', intent: 'rename' },
				resolved: [{ id: 'x.ts:1:1#resolved', roles: ['read'] }],
				unresolved: [
					{ id: 'x.ts:2:1#unresolved:unresolved-symbol', reason: 'unresolved-symbol' },
				],
			},
			{ state: 'complete', resolved: [], unresolved: [], reasoning: '' },
		);
		expect(score).toMatchObject({ correct: false, falseComplete: true });
	});

	test('keeps full and paged proofs byte-exact for all tasks', () => {
		for (const task of V7_TASKS) {
			const root = join(v7FixtureRoot(), 'artifacts', task.id);
			const proof = readFileSync(join(root, 'paged', 'proof.bin'));
			const full = readFileSync(join(root, 'full', 'receipt.bin'));
			expect(proof.byteLength).toBe(full.byteLength);
			expect(sha256(proof)).toBe(sha256(full));
			const head = JSON.parse(readFileSync(join(root, 'paged', 'head.json'), 'utf8')) as {
				proof: { bytes: number; sha256: string };
			};
			expect(head.proof).toEqual({
				...head.proof,
				bytes: proof.byteLength,
				sha256: sha256(proof),
			});
		}
	});

	test('turns fixture, prompt, order, truth, artifact, parser, scoring, and manifest mutations red', () => {
		for (const kind of [
			'task',
			'prompt',
			'order',
			'truth',
			'artifact',
			'parser',
			'scoring',
			'manifest',
		] as const) {
			const root = fixtureCopy();
			try {
				if (kind === 'parser' || kind === 'scoring') {
					resealManifest(root, (manifest) => {
						const entry = manifest.externals.find((candidate) =>
							candidate.path.endsWith(
								kind === 'parser' ? 'v7-codex.ts' : 'v7-scoring.ts',
							),
						)!;
						entry.sha256 = '0'.repeat(64);
					});
				} else if (kind === 'manifest') {
					const path = join(root, 'manifest.json');
					chmodSync(path, 0o644);
					writeFileSync(
						path,
						readFileSync(path, 'utf8').replace('guessless.v7', 'mutated.v7'),
					);
				} else {
					const relativePath =
						kind === 'task'
							? 'tasks.json'
							: kind === 'prompt'
								? 'prompts.json'
								: kind === 'order'
									? 'order.json'
									: kind === 'truth'
										? 'ground-truth.json.gz'
										: `artifacts/${V7_TASKS[0]!.id}/full/receipt.bin`;
					const path = join(root, relativePath);
					chmodSync(path, 0o644);
					const bytes = readFileSync(path);
					writeFileSync(path, Buffer.concat([bytes, Buffer.from('x')]));
				}
				expect(() => verifyV7Fixture(root), kind).toThrow();
			} finally {
				makeWritable(root);
				rmSync(root, { recursive: true, force: true });
				temporary.splice(temporary.indexOf(root), 1);
			}
		}
	});
});
