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
	V11_BUDGETS,
	V11_MODEL,
	V11_POLICY,
	V11_SEAL_SCHEMA,
	V11_TASKS,
	buildV11Order,
	buildV11Prompts,
	sha256,
	stableJson,
	v11FixtureRoot,
} from '../src/v11-contracts.ts';
import { fakeV11Preflight, parseV11Jsonl, persistAndParseV11 } from '../src/v11-codex.ts';
import { verifyV11Fixture } from '../src/v11-runner.ts';
import { scoreV11Response, validateV11Response } from '../src/v11-scoring.ts';

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

describe('oracle part 3 v11 one-shot measurement', () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const root of temporary.splice(0)) {
			makeWritable(root);
			rmSync(root, { recursive: true, force: true });
		}
	});

	function fixtureCopy(): string {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v11-mutation-'));
		temporary.push(root);
		cpSync(v11FixtureRoot(), root, { recursive: true, preserveTimestamps: true });
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
		expect(V11_TASKS).toHaveLength(1);
		expect(buildV11Order()).toHaveLength(1);
		expect(buildV11Order().map((cell) => cell.ordinal)).toEqual([1]);
		expect(buildV11Order()[0]).toMatchObject({ kind: 'discovery', arm: 'production' });
		expect(V11_MODEL).toBe('gpt-5.6-sol');
		expect(V11_POLICY).toMatchObject({ retries: 0, replacements: 0, rescoring: false });
		expect(V11_BUDGETS).toMatchObject({
			perCell: { maxToolCalls: 16, maxReportedTokens: 500_000, timeoutMs: 300_000 },
			aggregate: { maxToolCalls: 16, maxReportedTokens: 500_000 },
		});
		expect(JSON.stringify(buildV11Prompts())).not.toMatch(
			/guessless|oracle|mcp|safe[_ -]?change|prepare[_ -]?snapshot/i,
		);
		expect(verifyV11Fixture()).toMatchObject({ tasks: 1, cells: 1 });
	});

	test('declares provider-compatible types for every seal property', () => {
		for (const property of Object.values(V11_SEAL_SCHEMA.properties))
			expect(property).toHaveProperty('type');
		expect(V11_SEAL_SCHEMA.properties.schema).toMatchObject({
			type: 'string',
			const: 'guessless.v11-answer-seal/v1',
		});
		expect(V11_SEAL_SCHEMA.properties.path).toMatchObject({
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
		const parsed = parseV11Jsonl(
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
		const diagnostics = parseV11Jsonl(
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
			parseV11Jsonl('{"type":"turn.failed"}\n{"type":"error","message":"detail"}', 1),
		).toMatchObject({ diagnostics: 1, failed: true });
		expect(() =>
			parseV11Jsonl(
				'{"type":"turn.completed","usage":{"total_tokens":1}}\n{"type":"turn.failed"}',
				1,
			),
		).toThrow(/multiple terminal/);
		expect(() =>
			parseV11Jsonl(
				'{"type":"turn.completed","usage":{"total_tokens":1}}\n{"type":"item.started","item":{"id":"x","type":"command_execution"}}',
				1,
			),
		).toThrow(/tool lifecycle/);
	});

	test('persists raw stdout and stderr before parsing', () => {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v11-raw-'));
		temporary.push(root);
		const stdoutPath = join(root, 'cell.jsonl');
		const stderrPath = join(root, 'cell.stderr');
		expect(() =>
			persistAndParseV11('not-json\n', 'diagnostic\n', stdoutPath, stderrPath, 1),
		).toThrow();
		expect(readFileSync(stdoutPath, 'utf8')).toBe('not-json\n');
		expect(readFileSync(stderrPath, 'utf8')).toBe('diagnostic\n');
	});

	test('has exact fake all-success and first-failure topology', () => {
		const fake = fakeV11Preflight(buildV11Order());
		expect(fake.allSuccess).toMatchObject({ outcome: 'complete' });
		expect(fake.firstFailure).toMatchObject({ outcome: 'partial-NO_GO' });
		expect(fake.spawnedOnFailure).toBe(1);
		expect(fake.unrunOnFailure).toBe(0);
		expect(
			fake.firstFailure.records.filter((record) => record.status === 'unrun'),
		).toHaveLength(0);
	});

	test('validates answers fail closed and scores false completeness', () => {
		expect(() =>
			validateV11Response({ state: 'complete', resolved: [], unresolved: [] }),
		).toThrow();
		const score = scoreV11Response(
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
		for (const task of V11_TASKS) {
			const root = join(v11FixtureRoot(), 'artifacts', task.id);
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
								kind === 'parser' ? 'v11-codex.ts' : 'v11-scoring.ts',
							),
						)!;
						entry.sha256 = '0'.repeat(64);
					});
				} else if (kind === 'manifest') {
					const path = join(root, 'manifest.json');
					chmodSync(path, 0o644);
					writeFileSync(
						path,
						readFileSync(path, 'utf8').replace('guessless.v11', 'mutated.v11'),
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
										: `artifacts/${V11_TASKS[0]!.id}/full/receipt.bin`;
					const path = join(root, relativePath);
					chmodSync(path, 0o644);
					const bytes = readFileSync(path);
					writeFileSync(path, Buffer.concat([bytes, Buffer.from('x')]));
				}
				expect(() => verifyV11Fixture(root), kind).toThrow();
			} finally {
				makeWritable(root);
				rmSync(root, { recursive: true, force: true });
				temporary.splice(temporary.indexOf(root), 1);
			}
		}
	});
});
