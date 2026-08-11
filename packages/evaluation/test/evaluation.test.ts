import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
	BUDGETS,
	MODEL,
	ORDER,
	SYSTEM_INSTRUCTION,
	TASKS,
	V2_EVIDENCE_ID,
	V3_BUDGETS,
	V3_EVIDENCE_ID,
	V3_ORDER,
	V4_EVIDENCE_ID,
	V4_EXPOSURE_INSTRUCTION,
	V4_ORDER,
	V4_SYSTEM_INSTRUCTION,
	V5_EVIDENCE_ID,
	V5_ORDER,
	V5_TASKS,
} from '../src/contracts.ts';
import { fileLedger, paths, sha256, sha256File, stableJson } from '../src/contracts.ts';
import {
	buildChildEnvironment,
	inspectCodexTranscript,
	replayCodexTranscript,
	type CodexRun,
} from '../src/codex.ts';
import {
	assertCodexResponseSchemaCompatible,
	calibrate,
	executeRunSequence,
	hasRunFatalComponent,
} from '../src/evidence.ts';
import { loadGroundTruth, loadProtocol, proveGroundTruth } from '../src/fixtures.ts';
import {
	aggregate,
	analyzePairs,
	exactMedianSummary,
	exactSignTest,
	isV3FalseComplete,
	scoreCell,
	validateResponse,
	validateV5Response,
} from '../src/scoring.ts';

describe('sealed evaluation protocol', () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
	});
	const scratch = (): string => {
		const path = mkdtempSync(join(tmpdir(), 'guessless-evaluation-test-'));
		temporary.push(path);
		return path;
	};

	test('freezes exact model, prompts, instruction, budgets, and order', () => {
		const protocol = loadProtocol();
		expect(protocol.model).toBe(MODEL);
		expect(protocol.systemInstruction).toBe(SYSTEM_INSTRUCTION);
		expect(protocol.tasks).toEqual(TASKS);
		expect(protocol.budgets).toEqual(BUDGETS);
		expect(protocol.order).toEqual(ORDER);
	});

	test('isolates v2 identity while preserving exact fairness inputs', () => {
		const v1Paths = paths();
		const v2Paths = paths(undefined, V2_EVIDENCE_ID);
		const v1 = loadProtocol(v1Paths.fixtureRoot);
		const v2 = loadProtocol(v2Paths.fixtureRoot);
		expect(v2Paths.fixtureRoot).not.toBe(v1Paths.fixtureRoot);
		expect(v2Paths.evidenceRoot).toMatch(/oracle-part-3-v2$/);
		expect(v2.evidenceId).toBe(V2_EVIDENCE_ID);
		expect(v2.schema).toBe('guessless.evaluation-protocol/v2');
		const v1Copy = { ...v1 } as Record<string, unknown>;
		const v2Copy = { ...v2 } as Record<string, unknown>;
		for (const key of ['evidenceId', 'schema', 'responseSchemaSha256'] as const) {
			delete v1Copy[key];
			delete v2Copy[key];
		}
		expect(v2Copy).toEqual(v1Copy);
		expect(fileLedger(join(v2Paths.fixtureRoot, 'input'))).toEqual(
			fileLedger(join(v1Paths.fixtureRoot, 'input')),
		);
		expect(readFileSync(join(v2Paths.fixtureRoot, 'ground-truth.json'))).toEqual(
			readFileSync(join(v1Paths.fixtureRoot, 'ground-truth.json')),
		);
	});

	test('v2 schema deletes exactly two uniqueItems keys and compatibility is effect-free', () => {
		const v1Schema = JSON.parse(
			readFileSync(join(paths().fixtureRoot, 'response.schema.json'), 'utf8'),
		);
		const expectedV2 = structuredClone(v1Schema);
		delete expectedV2.properties.reportedSiteIds.uniqueItems;
		delete expectedV2.properties.unresolvedSiteIds.uniqueItems;
		const v2SchemaBytes = readFileSync(
			join(paths(undefined, V2_EVIDENCE_ID).fixtureRoot, 'response.schema.json'),
		);
		expect(JSON.parse(v2SchemaBytes.toString())).toEqual(expectedV2);
		const effects = {
			priorLookup: 0,
			executableResolution: 0,
			login: 0,
			staging: 0,
			runner: 0,
			spawn: 0,
		};
		expect(() =>
			assertCodexResponseSchemaCompatible(
				readFileSync(join(paths().fixtureRoot, 'response.schema.json')),
			),
		).toThrow(/uniqueItems/);
		expect(() => assertCodexResponseSchemaCompatible(v2SchemaBytes)).not.toThrow();
		expect(effects).toEqual({
			priorLookup: 0,
			executableResolution: 0,
			login: 0,
			staging: 0,
			runner: 0,
			spawn: 0,
		});
	});

	test('freezes isolated v3 identity, exact 36-cell order, and byte parity with v2', () => {
		const v2 = paths(undefined, V2_EVIDENCE_ID);
		const v3 = paths(undefined, V3_EVIDENCE_ID);
		const protocol = loadProtocol(v3.fixtureRoot);
		expect(protocol.evidenceId).toBe(V3_EVIDENCE_ID);
		expect(protocol.schema).toBe('guessless.evaluation-protocol/v3');
		expect(protocol.order).toEqual(V3_ORDER);
		expect(protocol.budgets).toEqual(V3_BUDGETS);
		expect(protocol.budgets).not.toHaveProperty('maxReportedTotalTokens');
		expect(v3.evidenceRoot).toMatch(/oracle-part-3-v3$/);
		for (const relative of [
			'ground-truth.json',
			'response.schema.json',
			...protocol.inputFiles.map((file) => `input/${file.path}`),
		])
			expect(readFileSync(join(v3.fixtureRoot, relative))).toEqual(
				readFileSync(join(v2.fixtureRoot, relative)),
			);
		expect(new Set(V3_ORDER.map((cell) => cell.id)).size).toBe(36);
		for (const task of ['rename', 'delete', 'reach'] as const) {
			const cells = V3_ORDER.filter((cell) => cell.task === task);
			expect(cells).toHaveLength(12);
			expect(
				cells.filter((cell, index) => index % 2 === 0 && cell.arm === 'control'),
			).toHaveLength(3);
		}
	});

	test('freezes v4 shared exposure semantics while preserving exact v3 parity', () => {
		const v3 = paths(undefined, V3_EVIDENCE_ID);
		const v4 = paths(undefined, V4_EVIDENCE_ID);
		const protocol = loadProtocol(v4.fixtureRoot);
		expect(protocol.evidenceId).toBe(V4_EVIDENCE_ID);
		expect(protocol.schema).toBe('guessless.evaluation-protocol/v4');
		expect(protocol.order).toEqual(V4_ORDER);
		expect(protocol.systemInstruction).toBe(V4_SYSTEM_INSTRUCTION);
		expect(protocol.systemInstruction).toBe(`${SYSTEM_INSTRUCTION} ${V4_EXPOSURE_INSTRUCTION}`);
		for (const relative of [
			'ground-truth.json',
			'response.schema.json',
			...protocol.inputFiles.map((file) => `input/${file.path}`),
		])
			expect(readFileSync(join(v4.fixtureRoot, relative))).toEqual(
				readFileSync(join(v3.fixtureRoot, relative)),
			);
	});

	test('v4 deterministically selects the last valid message with one later turn', () => {
		const response = (reasoning: string) => ({
			status: 'complete',
			reportedSiteIds: ['rename/direct.ts:2:37'],
			unresolvedSiteIds: [],
			reasoning,
		});
		const valid = Buffer.from(
			[response('draft'), response('final')]
				.map((value) =>
					JSON.stringify({
						type: 'item.completed',
						item: { type: 'agent_message', text: JSON.stringify(value) },
					}),
				)
				.concat(
					JSON.stringify({
						type: 'turn.completed',
						usage: { input_tokens: 10, output_tokens: 5 },
					}),
				)
				.join('\n') + '\n',
		);
		expect(replayCodexTranscript(valid, 'v4')).toMatchObject({
			terminal: { reasoning: 'final' },
			reportedTotalTokens: 15,
			terminalMessages: 2,
		});
		const trailing = Buffer.from(
			`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response('before')) } })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response('after')) } })}\n`,
		);
		expect(() => replayCodexTranscript(trailing, 'v4')).toThrow(/ordering/);
	});

	test('v5 freezes task-prefixed prompts and proves its oracle from source bytes and lexemes', () => {
		const v5 = paths(undefined, V5_EVIDENCE_ID);
		const protocol = loadProtocol(v5.fixtureRoot);
		expect(protocol.evidenceId).toBe(V5_EVIDENCE_ID);
		expect(protocol.schema).toBe('guessless.evaluation-protocol/v5');
		expect(protocol.order).toEqual(V5_ORDER);
		expect(protocol.tasks).toEqual(V5_TASKS);
		expect(protocol.systemInstruction).toBe(V4_SYSTEM_INSTRUCTION);
		expect(proveGroundTruth(v5.fixtureRoot)).toEqual(loadGroundTruth(v5.fixtureRoot));
	});

	test('v5 response contract requires task prefixes and disjoint fields', () => {
		const response = validateResponse({
			status: 'partial',
			reportedSiteIds: ['delete/state.ts:3:2'],
			unresolvedSiteIds: ['delete/dynamic.ts:3:55'],
			reasoning: 'fixture',
		});
		expect(validateV5Response('delete', response)).toBe(response);
		expect(() =>
			validateV5Response('delete', { ...response, reportedSiteIds: ['state.ts:3:2'] }),
		).toThrow(/begin with delete\//);
		expect(() =>
			validateV5Response('delete', {
				...response,
				unresolvedSiteIds: ['delete/state.ts:3:2'],
			}),
		).toThrow(/overlap/);
		expect(() => validateV5Response('delete', { ...response, status: 'complete' })).toThrow(
			/complete response/,
		);
	});

	test('uses exact integer sign tests, deterministic median intervals, and decision precedence', () => {
		expect(exactSignTest([1, 1, 1, 1, 1, 0])).toMatchObject({
			wins: 5,
			losses: 0,
			ties: 1,
			treatmentP: 0.03125,
			twoSidedP: 0.0625,
		});
		expect(exactSignTest([0, 0])).toMatchObject({
			directionalN: 0,
			treatmentP: 1,
			harmP: 1,
			twoSidedP: 1,
		});
		expect(exactMedianSummary(Array.from({ length: 18 }, (_, index) => index + 1))).toEqual({
			n: 18,
			median: 9.5,
			interval95: [5, 14],
		});
		expect(exactMedianSummary([1, 2, 3])).toMatchObject({ interval95: [null, null] });
		const pair = (task: 'rename' | 'delete' | 'reach', ratio: number) => ({
			task,
			controlCorrect: true,
			treatmentCorrect: true,
			controlFalseCompleteness: false,
			treatmentFalseCompleteness: false,
			durationRatio: ratio,
			tokenRatio: 1,
			toolCallDelta: 0,
		});
		const tasks = ['rename', 'delete', 'reach'] as const;
		const fast = tasks.flatMap((task) => Array.from({ length: 6 }, () => pair(task, 0.5)));
		expect(analyzePairs(fast, { rename: 6, delete: 6, reach: 6 }, false).decision).toBe(
			'ADOPT',
		);
		const slow = tasks.flatMap((task) => Array.from({ length: 6 }, () => pair(task, 2)));
		expect(analyzePairs(slow, { rename: 6, delete: 6, reach: 6 }, false).decision).toBe(
			'DO_NOT_ADOPT',
		);
		expect(
			analyzePairs(fast.slice(0, 15), { rename: 6, delete: 6, reach: 3 }, false).decision,
		).toBe('INCONCLUSIVE');
		const pilot = tasks.flatMap((task) => Array.from({ length: 6 }, () => pair(task, 1)));
		expect(analyzePairs(pilot, { rename: 6, delete: 6, reach: 6 }, false).decision).toBe(
			'PILOT',
		);
		expect(analyzePairs(fast, { rename: 6, delete: 6, reach: 6 }, true).decision).toBe(
			'INCONCLUSIVE',
		);
		const underrepresented = tasks.flatMap((task) =>
			Array.from({ length: 6 }, (_, index) => ({
				...pair(task, 0.5),
				controlCorrect: task !== 'reach' || index < 4,
				treatmentCorrect: task !== 'reach' || index < 4,
			})),
		);
		expect(
			analyzePairs(underrepresented, { rename: 6, delete: 6, reach: 6 }, false),
		).toMatchObject({
			bothCorrectPairs: 16,
			bothCorrectPairsByTask: { rename: 6, delete: 6, reach: 4 },
			decision: 'PILOT',
		});
	});

	test('recognizes RUN_FATAL at every canonical cumulative component position', () => {
		expect(hasRunFatalComponent('RUN_FATAL: first')).toBe(true);
		expect(hasRunFatalComponent('PROCESS_STATUS: 1 | RUN_FATAL: postflight mismatch')).toBe(
			true,
		);
		expect(hasRunFatalComponent('PROCESS_STATUS: 1 | TRANSCRIPT: invalid')).toBe(false);
	});

	test('v3 treats every complete truth-unresolved response as false-complete', () => {
		const truth = loadGroundTruth(paths(undefined, V3_EVIDENCE_ID).fixtureRoot);
		for (const task of ['delete', 'reach'] as const)
			expect(
				isV3FalseComplete(
					{
						status: 'complete',
						reportedSiteIds: truth[task].planted,
						unresolvedSiteIds: truth[task].unresolved,
						reasoning: 'all IDs named but truth is structurally unresolved',
					},
					truth[task],
				),
			).toBe(true);
	});

	test('rejects duplicate IDs in direct and transcript validation', () => {
		for (const field of ['reportedSiteIds', 'unresolvedSiteIds'] as const) {
			const response = {
				status: 'partial',
				reportedSiteIds: [] as string[],
				unresolvedSiteIds: [] as string[],
				reasoning: 'duplicate probe',
			};
			response[field] = ['rename/api.ts:1:1', 'rename/api.ts:1:1'];
			expect(() => validateResponse(response)).toThrow(/schema/);
			const transcript = Buffer.from(
				`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } })}\n`,
			);
			expect(inspectCodexTranscript(transcript).error).toMatch(/schema/);
			expect(() => replayCodexTranscript(transcript)).toThrow(/schema/);
		}
	});

	test('mechanically proves unique planted sites and engine receipts', () => {
		const proof = proveGroundTruth();
		expect(Object.keys(proof).sort()).toEqual(['delete', 'reach', 'rename']);
	});

	test('validates response schema and deterministically scores false completeness', () => {
		const response = validateResponse({
			status: 'complete',
			reportedSiteIds: ['rename/direct.ts:2:37'],
			unresolvedSiteIds: [],
			reasoning: 'fixture',
		});
		const score = scoreCell('rename', 'control', response, loadGroundTruth());
		expect(score.sitesMissed.length).toBe(3);
		expect(score.falseCompleteness).toBe(1);
		expect(aggregate([score])).toHaveProperty('control');
		expect(() => validateResponse({ status: 'complete' })).toThrow(/schema/);
	});

	test('fixtures are read-only inputs without embedded ground truth', () => {
		const protocol = loadProtocol();
		const ledger = protocol.inputFiles as readonly { path: string }[];
		expect(ledger.some((file) => file.path.includes('ground-truth'))).toBe(false);
		expect(ledger.length).toBe(15);
	});

	test('derives only exact source and dist anchors independent of cwd/env', () => {
		const root = resolve(import.meta.dirname, '../../..');
		for (const module of [
			join(root, 'packages/evaluation/src/contracts.ts'),
			join(root, 'packages/evaluation/dist/cli.js'),
		])
			expect(paths(pathToFileURL(module).href).root).toBe(root);
		const oldCwd = process.cwd();
		const oldPwd = process.env.PWD;
		try {
			process.chdir(scratch());
			process.env.PWD = '/spoofed';
			expect(
				paths(pathToFileURL(join(root, 'packages/evaluation/src/contracts.ts')).href).root,
			).toBe(root);
		} finally {
			process.chdir(oldCwd);
			if (oldPwd === undefined) delete process.env.PWD;
			else process.env.PWD = oldPwd;
		}
		expect(() =>
			paths(pathToFileURL(join(root, 'packages/evaluation/src/other.ts')).href),
		).toThrow(/layout/);
		expect(() =>
			paths(
				pathToFileURL(join(root, 'packages/evaluation/src/other.ts')).href,
				V2_EVIDENCE_ID,
			),
		).toThrow(/layout/);
		expect(() => paths(undefined, 'oracle-part-3-attacker' as never)).toThrow(/identity/);
		const fake = scratch();
		mkdirSync(join(fake, 'packages/evaluation/src'), { recursive: true });
		mkdirSync(join(fake, 'docs/evidence'), { recursive: true });
		cpSync(
			join(root, 'packages/evaluation/fixtures'),
			join(fake, 'packages/evaluation/fixtures'),
			{ recursive: true },
		);
		writeFileSync(join(fake, 'package.json'), '{"name":"guessless-workspace"}');
		writeFileSync(
			join(fake, 'packages/evaluation/package.json'),
			'{"name":"@guessless/evaluation"}',
		);
		writeFileSync(join(fake, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
		const fakeModule = join(fake, 'packages/evaluation/src/contracts.ts');
		writeFileSync(fakeModule, '');
		expect(paths(pathToFileURL(realpathSync(fakeModule)).href).root).toBe(realpathSync(fake));
		const aliasParent = scratch();
		const rootAlias = join(aliasParent, 'root-alias');
		symlinkSync(realpathSync(fake), rootAlias, 'dir');
		expect(() =>
			paths(pathToFileURL(join(rootAlias, 'packages/evaluation/src/contracts.ts')).href),
		).toThrow(/lexical\/canonical|symlink/);
		const packagesAlias = join(fake, 'packages-alias');
		symlinkSync(join(fake, 'packages'), packagesAlias, 'dir');
		expect(() =>
			paths(pathToFileURL(join(packagesAlias, 'evaluation/src/contracts.ts')).href),
		).toThrow();
		rmSync(packagesAlias);
		const fixture = join(fake, 'packages/evaluation/fixtures/oracle-part-3-v1');
		const fixtureSaved = `${fixture}-saved`;
		renameSync(fixture, fixtureSaved);
		symlinkSync(paths().fixtureRoot, fixture, 'dir');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(
			/fixture|lexical\/canonical|symlink/,
		);
		rmSync(fixture);
		renameSync(fixtureSaved, fixture);
		const docs = join(fake, 'docs');
		const docsSaved = `${docs}-saved`;
		renameSync(docs, docsSaved);
		symlinkSync(join(root, 'docs'), docs, 'dir');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(
			/docs|lexical\/canonical|symlink/,
		);
		rmSync(docs);
		renameSync(docsSaved, docs);
		const evidence = join(fake, 'docs/evidence');
		const evidenceSaved = `${evidence}-saved`;
		renameSync(evidence, evidenceSaved);
		symlinkSync(join(root, 'docs/evidence'), evidence, 'dir');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(
			/evidence|lexical\/canonical|symlink/,
		);
		rmSync(evidence);
		renameSync(evidenceSaved, evidence);
		writeFileSync(join(fake, 'pnpm-workspace.yaml'), 'packages:\n  - wrong/*\n');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(/workspace/);
		writeFileSync(join(fake, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
		writeFileSync(join(fake, 'packages/evaluation/package.json'), '{"name":"wrong"}');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(/marker/);
		writeFileSync(
			join(fake, 'packages/evaluation/package.json'),
			'{"name":"@guessless/evaluation"}',
		);
		writeFileSync(join(fake, 'package.json'), '{"name":"wrong"}');
		expect(() => paths(pathToFileURL(realpathSync(fakeModule)).href)).toThrow(/marker/);
		writeFileSync(join(fake, 'package.json'), '{"name":"guessless-workspace"}');
		rmSync(fakeModule);
		symlinkSync(join(root, 'packages/evaluation/src/contracts.ts'), fakeModule);
		expect(() => paths(pathToFileURL(fakeModule).href)).toThrow(/symlink|lexical\/canonical/);
	});

	test('uses one explicit secret-free environment for both arms', () => {
		const environment = buildChildEnvironment();
		expect(Object.keys(environment).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
		expect(Object.keys(environment).some((name) => /secret|token|key|auth/i.test(name))).toBe(
			false,
		);
	});

	test('rejects frozen uniqueItems locally before any live effect', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		const stage = join(scratch(), '.staging-oracle-part-3-v1-sentinel');
		let loginCalls = 0;
		let runnerCalls = 0;
		let modelSpawnCalls = 0;
		try {
			expect(() => {
				assertCodexResponseSchemaCompatible(
					readFileSync(join(paths().fixtureRoot, 'response.schema.json')),
				);
				loginCalls += 1;
				mkdirSync(stage);
				runnerCalls += 1;
				modelSpawnCalls += 1;
			}).toThrow(/uniqueItems/);
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
		expect({ loginCalls, runnerCalls, modelSpawnCalls }).toEqual({
			loginCalls: 0,
			runnerCalls: 0,
			modelSpawnCalls: 0,
		});
		expect(existsSync(stage)).toBe(false);
	});

	test('calibrates canonical failed and unrun ledgers without terminal scores', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		try {
			expect(() =>
				calibrate(['--offline', '--fixture-only', '--evidence-id', 'oracle-part-3-v1']),
			).not.toThrow();
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
	});

	test('calibrates v2 source fixtures, duplicates, benchmarks, and failed ledgers', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		try {
			expect(() =>
				calibrate(['--offline', '--fixture-only', '--evidence-id', V2_EVIDENCE_ID]),
			).not.toThrow();
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
	});

	test('calibrates v3 order, parity, continuation, token semantics, statistics, and decisions', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		try {
			expect(() =>
				calibrate(['--offline', '--fixture-only', '--evidence-id', V3_EVIDENCE_ID]),
			).not.toThrow();
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
	});

	test('calibrates v4 exposure, terminals, MCP smoke, replay, and 82-file topology offline', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		try {
			expect(() =>
				calibrate(['--offline', '--fixture-only', '--evidence-id', V4_EVIDENCE_ID]),
			).not.toThrow();
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
	});

	test('calibrates v5 oracle, path parity, response fields, replay, and topology offline', () => {
		const oldConsent = process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = 'disabled';
		try {
			expect(() =>
				calibrate(['--offline', '--fixture-only', '--evidence-id', V5_EVIDENCE_ID]),
			).not.toThrow();
		} finally {
			if (oldConsent === undefined) delete process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT;
			else process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT = oldConsent;
		}
	});

	test.each([0, 2, 5])('production sequence durably preserves failure at cell %i', (failedAt) => {
		const stage = scratch();
		mkdirSync(join(stage, 'raw'));
		mkdirSync(join(stage, '.preflight'));
		cpSync(join(paths().fixtureRoot, 'input'), join(stage, '.preflight/input'), {
			recursive: true,
		});
		cpSync(join(paths().fixtureRoot, 'protocol.json'), join(stage, '.preflight/protocol.json'));
		cpSync(
			join(paths().fixtureRoot, 'response.schema.json'),
			join(stage, '.preflight/response.schema.json'),
		);
		writeFileSync(
			join(stage, '.preflight/manifest.json'),
			stableJson({
				protocolSha256: sha256File(join(stage, '.preflight/protocol.json')),
				responseSchemaSha256: sha256File(join(stage, '.preflight/response.schema.json')),
				inputFiles: fileLedger(join(stage, '.preflight/input')),
			}),
		);
		let calls = 0;
		const truth = loadGroundTruth();
		const runner = (task: keyof typeof TASKS, arm: 'control' | 'guessless'): CodexRun => {
			const index = calls++;
			const stdout = Buffer.from(`fake-${index}\n`);
			const stderr = Buffer.from(index === failedAt ? 'transport failed\n' : '');
			return {
				argv: [
					'codex',
					...(arm === 'guessless' ? ['mcp_servers.guessless.command=node'] : []),
				],
				environmentNames: ['HOME', 'LANG', 'PATH', 'TMPDIR'],
				environmentValueFingerprints: { HOME: 'h', LANG: 'l', PATH: 'p', TMPDIR: 't' },
				status: index === failedAt ? 1 : 0,
				signal: null,
				timedOut: false,
				durationMs: 1,
				stdout,
				stderr,
				stdoutSha256: sha256(stdout),
				stderrSha256: sha256(stderr),
				toolCalls: 1,
				reportedTotalTokens: 10,
				guesslessInvocations: arm === 'guessless' ? 1 : 0,
				...(index === failedAt
					? { failureReason: 'transport failure' }
					: {
							terminal: {
								status: 'complete' as const,
								reportedSiteIds: truth[task].planted,
								unresolvedSiteIds: truth[task].unresolved,
								reasoning: 'fake',
							},
						}),
			};
		};
		const runs = executeRunSequence(stage, runner);
		expect(calls).toBe(failedAt + 1);
		expect(runs[failedAt].state).toBe('failed');
		expect(runs.slice(failedAt + 1).every((run) => run.state === 'unrun')).toBe(true);
	});
});
