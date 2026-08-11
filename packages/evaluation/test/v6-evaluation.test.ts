import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { makeSafeChangeSummary, verifySafeChangeSummary } from '../../engine/src/index.ts';
import {
	V6_BUDGETS,
	V6_POLICY,
	V6_REPOSITORIES,
	V6_TASKS,
	sha256,
	stableJson,
} from '../src/v6-contracts.ts';
import { inspectV6Transcript, runFakeOnlyPreflight } from '../src/v6-codex.ts';
import { computeRepositoryArtifacts, readCompressedJson, v6FixtureRoot } from '../src/v6-corpus.ts';
import { verifyV6Preregistration } from '../src/v6-preregistration.ts';
import { oneSidedExactP, scoreV6Response, validateV6Response } from '../src/v6-scoring.ts';

interface ManifestFile {
	path: string;
	bytes: number;
	sha256: string;
}

function reseal(root: string, relativePath: string): void {
	const manifestPath = join(root, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
		files: ManifestFile[];
		integrity: string;
	};
	const entry = manifest.files.find((candidate) => candidate.path === relativePath);
	if (entry === undefined) throw new Error(`missing manifest entry ${relativePath}`);
	const bytes = readFileSync(join(root, relativePath));
	entry.bytes = bytes.byteLength;
	entry.sha256 = sha256(bytes);
	const { integrity: _integrity, ...unsigned } = manifest;
	manifest.integrity = sha256(stableJson(unsigned));
	writeFileSync(manifestPath, stableJson(manifest));
}

describe('oracle part 3 v6 immutable preregistration', () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	function fixtureCopy(): string {
		const root = mkdtempSync(join(tmpdir(), 'guessless-v6-mutation-'));
		temporary.push(root);
		cpSync(v6FixtureRoot(), root, { recursive: true });
		return root;
	}

	test('freezes 18 balanced tasks, 72 counterbalanced cells, and all budgets', () => {
		expect(V6_TASKS).toHaveLength(18);
		for (const repository of V6_REPOSITORIES) {
			const tasks = V6_TASKS.filter((task) => task.repository === repository.id);
			expect(tasks.filter((task) => task.intent === 'rename')).toHaveLength(2);
			expect(tasks.filter((task) => task.intent === 'delete')).toHaveLength(2);
			expect(tasks.filter((task) => task.intent === 'entry-point')).toHaveLength(2);
		}
		expect(V6_POLICY).toMatchObject({ cellCount: 72, retries: 0, replacements: 0 });
		expect(V6_BUDGETS.aggregate.maxIncrementalDirectSpendUsd).toBe(0);
		expect(verifyV6Preregistration(import.meta.url, undefined, false)).toMatchObject({
			tasks: 18,
			cells: 72,
		});
	});

	test('runs a deterministic fake-only preflight without a model cell', () => {
		expect(runFakeOnlyPreflight()).toMatchObject({
			cells: 72,
			spawnedModelCells: 0,
			attemptedCells: 1,
			unrunCells: 71,
			stoppedAfterFirstFailure: true,
		});
		const delivery = inspectV6Transcript([
			{ type: 'tool.started', tool: 'guessless_safe_change_impact' },
			{ type: 'tool.cancelled', tool: 'guessless_safe_change_impact' },
			{ type: 'tool.started', tool: 'local-proof-reader' },
			{ type: 'proof.delivered', tool: 'local-proof-reader' },
			{ type: 'turn.completed', reportedTokens: 12, durationMs: 20 },
		]);
		expect(delivery).toMatchObject({
			starts: 2,
			cancellations: 1,
			deliveredResults: 0,
			proofReads: 1,
			toolCalls: 2,
		});
		expect(() =>
			inspectV6Transcript([
				{ type: 'tool.delivered', tool: 'unstarted' },
				{ type: 'turn.completed', reportedTokens: 0, durationMs: 0 },
			]),
		).toThrow(/matching tool start/);
	});

	test('keeps direct UFO summaries stable and rejects parsed-full reconstruction identity', () => {
		const repository = V6_REPOSITORIES[0]!;
		const archive = join(v6FixtureRoot(), 'archives', repository.archive);
		const first = computeRepositoryArtifacts(repository, archive);
		const second = computeRepositoryArtifacts(repository, archive);
		expect(stableJson(first.artifacts)).toBe(stableJson(second.artifacts));
		expect(stableJson(first.truth)).toBe(stableJson(second.truth));
		expect(stableJson(first.sourceLedger)).toBe(stableJson(second.sourceLedger));
		const taskId = 'ufo-rename-encode-query-item';
		const direct = first.artifacts.find((artifact) => artifact.task.id === taskId)!;
		const sealedBytes = readFileSync(
			join(v6FixtureRoot(), 'receipts', `${taskId}.summary.json`),
			'utf8',
		);
		expect(sealedBytes).toBe(`${JSON.stringify(direct.summary, null, '\t')}\n`);
		const parsedFull = readCompressedJson(
			join(v6FixtureRoot(), 'receipts', `${taskId}.full.json.gz`),
		);
		const staleRewrite = makeSafeChangeSummary(parsedFull as never);
		expect(verifySafeChangeSummary(staleRewrite)).toBe(true);
		expect(staleRewrite.integrity).not.toBe(direct.summary.integrity);
		expect(`${JSON.stringify(staleRewrite, null, '\t')}\n`).not.toBe(sealedBytes);
	}, 300_000);

	test('rejects post-generation whitespace changes to ordinary and integrity-bound JSON', () => {
		for (const relativePath of [
			'tasks.json',
			'receipts/ufo-rename-encode-query-item.summary.json',
		]) {
			const root = fixtureCopy();
			const path = join(root, relativePath);
			const original = readFileSync(path, 'utf8');
			const reformatted = original.replace(/^\t/m, '  ');
			expect(reformatted).not.toBe(original);
			writeFileSync(path, reformatted);
			expect(JSON.parse(reformatted)).toEqual(JSON.parse(original));
			if (relativePath.endsWith('.summary.json'))
				expect(verifySafeChangeSummary(JSON.parse(reformatted))).toBe(true);
			expect(() => verifyV6Preregistration(import.meta.url, root, false)).toThrow(
				/v6 manifest verification failed/,
			);
		}
	});

	test('retains the Execa coordinate collision as disjoint qualified facts with anchor provenance', () => {
		const truth = JSON.parse(
			gunzipSync(readFileSync(join(v6FixtureRoot(), 'ground-truth.json.gz'))).toString(
				'utf8',
			),
		) as {
			task: { id: string };
			resolved: { id: string; coordinate: string; anchors: { semanticPath: string[] }[] }[];
			unresolved: { id: string; coordinate: string; anchors: { semanticPath: string[] }[] }[];
		}[];
		const task = truth.find((entry) => entry.task.id === 'execa-entry-execa-core-async')!;
		const resolvedCoordinates = new Set(task.resolved.map((site) => site.coordinate));
		const collisions = task.unresolved.filter((site) =>
			resolvedCoordinates.has(site.coordinate),
		);
		expect(collisions.length).toBeGreaterThan(0);
		for (const unresolved of collisions) {
			expect(unresolved.id).toContain('#unresolved:');
			expect(
				task.resolved.find((site) => site.coordinate === unresolved.coordinate)!.id,
			).toMatch(/#resolved$/);
			expect(unresolved.anchors.length).toBeGreaterThan(0);
		}
	});

	test('fails closed on overlaps, false completeness, and exact significance', () => {
		expect(() =>
			validateV6Response({
				state: 'partial',
				reasoning: '',
				resolved: [{ siteId: 'a', roles: ['read'] }],
				unresolved: [{ siteId: 'a', reason: 'unresolved-symbol' }],
			}),
		).toThrow(/overlaps/);
		const score = scoreV6Response(
			{
				task: { id: 'x', intent: 'rename' },
				resolved: [{ id: 'a', roles: ['read'] }],
				unresolved: [{ id: 'b', reason: 'unresolved-symbol' }],
			},
			{
				state: 'complete',
				resolved: [{ siteId: 'a', roles: ['read'] }],
				unresolved: [],
				reasoning: '',
			},
		);
		expect(score).toMatchObject({ correct: false, falseComplete: true });
		expect(oneSidedExactP(4, 0)).toBe(0.0625);
	});

	test('rejects independently resealed task, prompt, proof, and manifest mutations', () => {
		for (const kind of ['task', 'prompt', 'proof', 'manifest'] as const) {
			const root = fixtureCopy();
			if (kind === 'task') {
				const path = join(root, 'tasks.json');
				const value = JSON.parse(readFileSync(path, 'utf8')) as { symbol: string }[];
				value[0]!.symbol = 'mutated';
				writeFileSync(path, stableJson(value));
				reseal(root, 'tasks.json');
			} else if (kind === 'prompt') {
				const path = join(root, 'prompts.json');
				writeFileSync(
					path,
					readFileSync(path, 'utf8').replace('Assess the', 'Guessless should assess the'),
				);
				reseal(root, 'prompts.json');
			} else if (kind === 'proof') {
				const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
					files: ManifestFile[];
				};
				const relativePath = manifest.files.find((entry) =>
					entry.path.startsWith('proofs/'),
				)!.path;
				const path = join(root, relativePath);
				const value = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Record<
					string,
					unknown
				>;
				value.state = value.state === 'complete' ? 'partial' : 'complete';
				writeFileSync(path, gzipSync(Buffer.from(stableJson(value)), { level: 9 }));
				reseal(root, relativePath);
			} else {
				const path = join(root, 'manifest.json');
				const value = JSON.parse(readFileSync(path, 'utf8')) as { files: ManifestFile[] };
				value.files[0]!.bytes = statSync(join(root, value.files[0]!.path)).size + 1;
				writeFileSync(path, stableJson(value));
			}
			expect(() => verifyV6Preregistration(import.meta.url, root, false), kind).toThrow();
		}
	});
});
