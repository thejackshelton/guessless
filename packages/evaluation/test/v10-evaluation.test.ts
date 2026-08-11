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
	V10_BUDGETS,
	V10_MODEL,
	V10_POLICY,
	V10_SEAL_SCHEMA,
	V10_TASKS,
	buildV10Order,
	buildV10Prompts,
	sha256,
	stableJson,
	v10FixtureRoot,
} from '../src/v10-contracts.ts';
import { fakeV10Preflight, parseV10Jsonl, persistAndParseV10 } from '../src/v10-codex.ts';
import { verifyV10Fixture } from '../src/v10-runner.ts';
import { scoreV10Response, validateV10Response } from '../src/v10-scoring.ts';

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

describe('oracle part 3 v10 one-shot measurement', () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const root of temporary.splice(0)) {
			makeWritable(root);
			rmSync(root, { recursive: true, force: true });
		}
	});

	function fixtureCopy(): string {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v10-mutation-'));
		temporary.push(root);
		cpSync(v10FixtureRoot(), root, { recursive: true, preserveTimestamps: true });
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
		expect(V10_TASKS).toHaveLength(1);
		expect(buildV10Order()).toHaveLength(4);
		expect(buildV10Order().map((cell) => cell.ordinal)).toEqual(
			Array.from({ length: 4 }, (_, index) => index + 1),
		);
		expect(V10_MODEL).toBe('gpt-5.6-sol');
		expect(V10_POLICY).toMatchObject({ retries: 0, replacements: 0, rescoring: false });
		expect(V10_BUDGETS).toMatchObject({
			perCell: { maxToolCalls: 16, maxReportedTokens: 500_000, timeoutMs: 300_000 },
			aggregate: { maxToolCalls: 64, maxReportedTokens: 2_000_000 },
		});
		expect(JSON.stringify(buildV10Prompts())).not.toMatch(
			/guessless|oracle|mcp|safe[_ -]?change|prepare[_ -]?snapshot/i,
		);
		expect(verifyV10Fixture()).toMatchObject({ tasks: 1, cells: 4 });
	});

	test('declares provider-compatible types for every seal property', () => {
		for (const property of Object.values(V10_SEAL_SCHEMA.properties))
			expect(property).toHaveProperty('type');
		expect(V10_SEAL_SCHEMA.properties.schema).toMatchObject({
			type: 'string',
			const: 'guessless.v10-answer-seal/v1',
		});
		expect(V10_SEAL_SCHEMA.properties.path).toMatchObject({
			type: 'string',
			const: 'answer.json',
		});
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
		const parsed = parseV10Jsonl(
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
			diagnostics: 0,
			failed: false,
		});
		const diagnostics = parseV10Jsonl(
			[
				{ type: 'error', message: 'retrying' },
				{ type: 'turn.completed', usage: { total_tokens: 1 } },
				{ type: 'error', message: 'late diagnostic' },
			]
				.map((event) => JSON.stringify(event))
				.join('\n'),
			1,
		);
		expect(diagnostics).toMatchObject({ diagnostics: 2, failed: false });
		expect(
			parseV10Jsonl('{"type":"turn.failed"}\n{"type":"error","message":"detail"}', 1),
		).toMatchObject({ diagnostics: 1, failed: true });
		expect(() =>
			parseV10Jsonl(
				'{"type":"turn.completed","usage":{"total_tokens":1}}\n{"type":"turn.failed"}',
				1,
			),
		).toThrow(/multiple terminal/);
		expect(() =>
			parseV10Jsonl(
				'{"type":"turn.completed","usage":{"total_tokens":1}}\n{"type":"item.started","item":{"id":"x","type":"command_execution"}}',
				1,
			),
		).toThrow(/tool lifecycle/);
	});

	test('persists raw stdout and stderr before parsing', () => {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v10-raw-'));
		temporary.push(root);
		const stdoutPath = join(root, 'cell.jsonl');
		const stderrPath = join(root, 'cell.stderr');
		expect(() =>
			persistAndParseV10('not-json\n', 'diagnostic\n', stdoutPath, stderrPath, 1),
		).toThrow();
		expect(readFileSync(stdoutPath, 'utf8')).toBe('not-json\n');
		expect(readFileSync(stderrPath, 'utf8')).toBe('diagnostic\n');
	});

	test('has exact fake all-success and first-failure topology', () => {
		const fake = fakeV10Preflight(buildV10Order());
		expect(fake.allSuccess).toMatchObject({ outcome: 'complete' });
		expect(fake.firstFailure).toMatchObject({ outcome: 'partial-NO_GO' });
		expect(fake.spawnedOnFailure).toBe(1);
		expect(fake.unrunOnFailure).toBe(3);
		expect(
			fake.firstFailure.records.filter((record) => record.status === 'unrun'),
		).toHaveLength(3);
	});

	test('validates answers fail closed and scores false completeness', () => {
		expect(() =>
			validateV10Response({ state: 'complete', resolved: [], unresolved: [] }),
		).toThrow();
		const score = scoreV10Response(
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
		for (const task of V10_TASKS) {
			const root = join(v10FixtureRoot(), 'artifacts', task.id);
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
								kind === 'parser' ? 'v10-codex.ts' : 'v10-scoring.ts',
							),
						)!;
						entry.sha256 = '0'.repeat(64);
					});
				} else if (kind === 'manifest') {
					const path = join(root, 'manifest.json');
					chmodSync(path, 0o644);
					writeFileSync(
						path,
						readFileSync(path, 'utf8').replace('guessless.v10', 'mutated.v10'),
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
										: `artifacts/${V10_TASKS[0]!.id}/full/receipt.bin`;
					const path = join(root, relativePath);
					chmodSync(path, 0o644);
					const bytes = readFileSync(path);
					writeFileSync(path, Buffer.concat([bytes, Buffer.from('x')]));
				}
				expect(() => verifyV10Fixture(root), kind).toThrow();
			} finally {
				makeWritable(root);
				rmSync(root, { recursive: true, force: true });
				temporary.splice(temporary.indexOf(root), 1);
			}
		}
	});
});
