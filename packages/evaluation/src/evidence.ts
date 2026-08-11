import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import {
	FatalEvaluationError,
	buildChildEnvironment,
	containsSecret,
	inspectCodexTranscript,
	replayCodexTranscript,
	resolveCodexExecutable,
	runCodexCell,
	type CodexCellConfig,
	type CodexRun,
	type CellSpawner,
	type SpawnProvenance,
} from './codex.ts';
import {
	CODEX_VERSION,
	EVIDENCE_ID,
	MODEL,
	ORDER,
	TASKS,
	V2_EVIDENCE_ID,
	V3_EVIDENCE_ID,
	V3_ORDER,
	V4_EVIDENCE_ID,
	V4_ORDER,
	V5_EVIDENCE_ID,
	type EvidenceId,
	assertContained,
	assertRealDirectory,
	assertRealFile,
	fileLedger,
	paths,
	sha256,
	sha256File,
	stableJson,
} from './contracts.ts';
import {
	loadGroundTruth,
	loadProtocol,
	proveGroundTruth,
	proveReceiptGroundTruth,
} from './fixtures.ts';
import {
	aggregate,
	analyzePairs,
	exactMedianSummary,
	exactSignTest,
	isV3FalseComplete,
	scoreCell,
	validateV5Response,
	type CellScore,
	type PairMetricInput,
} from './scoring.ts';

interface RunRecordIdentity {
	readonly id: string;
	readonly task: keyof typeof TASKS;
	readonly arm: 'control' | 'guessless';
	readonly stdoutSha256: string;
	readonly stderrSha256: string;
}

interface ExecutedRunRecord extends RunRecordIdentity {
	readonly argv: readonly string[];
	readonly environmentNames: readonly string[];
	readonly environmentValueFingerprints: Readonly<Record<string, string>>;
	readonly status: number;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly toolCalls: number;
	readonly reportedTotalTokens: number;
	readonly guesslessInvocations: number;
	readonly spawnProvenance: SpawnProvenance;
	readonly immutablePostflight: boolean;
}

export type RunRecord =
	| (ExecutedRunRecord & {
			readonly state: 'completed';
			readonly status: 0;
			readonly signal: null;
			readonly timedOut: false;
			readonly immutablePostflight: false;
			readonly terminal: NonNullable<CodexRun['terminal']>;
			readonly failureReason?: never;
	  })
	| (ExecutedRunRecord & {
			readonly state: 'failed';
			readonly failureReason: string;
			readonly terminal?: NonNullable<CodexRun['terminal']>;
	  })
	| (RunRecordIdentity & {
			readonly state: 'unrun';
			readonly argv: readonly [];
			readonly environmentNames: readonly [];
			readonly environmentValueFingerprints: Readonly<Record<string, never>>;
			readonly status: null;
			readonly signal: null;
			readonly timedOut: false;
			readonly durationMs: 0;
			readonly toolCalls: 0;
			readonly reportedTotalTokens: 0;
			readonly guesslessInvocations: 0;
			readonly spawnProvenance?: never;
			readonly immutablePostflight?: never;
			readonly terminal?: never;
			readonly failureReason?: never;
	  });

interface ScoresFile {
	readonly cells: readonly CellScore[];
	readonly pairedTotals: Record<string, unknown>;
	readonly analysis?: Record<string, unknown>;
}

function isRepeatedEvidence(evidenceId: EvidenceId): boolean {
	return [V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(evidenceId);
}

function repeatedVersion(evidenceId: EvidenceId): 'v3' | 'v4' | 'v5' {
	return evidenceId === V5_EVIDENCE_ID ? 'v5' : evidenceId === V4_EVIDENCE_ID ? 'v4' : 'v3';
}

function orderFor(evidenceId: EvidenceId): typeof ORDER | typeof V4_ORDER {
	return isRepeatedEvidence(evidenceId) ? V4_ORDER : ORDER;
}

function correctCell(
	run: RunRecord,
	score: CellScore,
	truth: ReturnType<typeof loadGroundTruth>,
): boolean {
	if (run.state !== 'completed' || run.terminal === undefined) return false;
	const expectedStatus = truth[run.task].unresolved.length === 0 ? 'complete' : 'partial';
	return (
		run.terminal.status === expectedStatus &&
		score.sitesMissed.length === 0 &&
		score.falsePositives.length === 0 &&
		stableJson(score.unresolved) === stableJson([...truth[run.task].unresolved].sort())
	);
}

function scoreV3Cell(
	task: keyof typeof TASKS,
	arm: 'control' | 'guessless',
	terminal: NonNullable<CodexRun['terminal']>,
	truth: ReturnType<typeof loadGroundTruth>,
): CellScore {
	const score = scoreCell(task, arm, terminal, truth);
	return {
		...score,
		falseCompleteness: isV3FalseComplete(terminal, truth[task]) ? 1 : 0,
	};
}

function v3AnalysisFor(
	runs: readonly RunRecord[],
	truth: ReturnType<typeof loadGroundTruth>,
): Record<string, unknown> {
	const runFatal = runs.some(
		(run) => run.state === 'failed' && hasRunFatalComponent(run.failureReason),
	);
	const scores = new Map(
		runs.flatMap((run) =>
			run.state === 'completed' && run.terminal !== undefined
				? [[run.id, scoreV3Cell(run.task, run.arm, run.terminal, truth)] as const]
				: [],
		),
	);
	const pairs: PairMetricInput[] = [];
	const validPairsByTask = { rename: 0, delete: 0, reach: 0 };
	for (let index = 0; index < V3_ORDER.length; index += 2) {
		const first = runs[index]!;
		const second = runs[index + 1]!;
		if (
			first.state !== 'completed' ||
			second.state !== 'completed' ||
			first.task !== second.task ||
			first.arm === second.arm
		)
			continue;
		const control = first.arm === 'control' ? first : second;
		const treatment = first.arm === 'guessless' ? first : second;
		const controlScore = scores.get(control.id)!;
		const treatmentScore = scores.get(treatment.id)!;
		validPairsByTask[first.task] += 1;
		pairs.push({
			task: first.task,
			controlCorrect: correctCell(control, controlScore, truth),
			treatmentCorrect: correctCell(treatment, treatmentScore, truth),
			controlFalseCompleteness: isV3FalseComplete(control.terminal, truth[first.task]),
			treatmentFalseCompleteness: isV3FalseComplete(treatment.terminal, truth[first.task]),
			...(control.durationMs > 0
				? { durationRatio: treatment.durationMs / control.durationMs }
				: {}),
			...(control.reportedTotalTokens > 0 && treatment.reportedTotalTokens > 0
				? { tokenRatio: treatment.reportedTotalTokens / control.reportedTotalTokens }
				: {}),
			toolCallDelta: treatment.toolCalls - control.toolCalls,
		});
	}
	return analyzePairs(pairs, validPairsByTask, runFatal);
}

function v3BenchmarksFor(
	protocol: ReturnType<typeof loadProtocol>,
	truth: ReturnType<typeof loadGroundTruth>,
	runs: readonly RunRecord[],
	analysis: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...benchmarksFor(protocol, truth, runs),
		schema: `guessless.evaluation-benchmarks/${repeatedVersion(protocol.evidenceId)}`,
		repetitionsPerTask: 6,
		pairs: 18,
		analysis,
		limitations: [
			'repeated trials estimate reliability only on three synthetic fixtures',
			'sequential execution may include order and warm-cache effects despite counterbalancing',
			'duration includes transport overhead',
			'reportedTotalTokens is final-turn fixed-context usage, not marginal task cost',
			'model output remains nondeterministic',
			'adoption decision is scoped to reversible sibling-repository integration',
		],
	};
}

const BENCHMARK_LIMITATIONS = [
	'n=1 per arm and task',
	'sequential execution may include order and warm-cache effects',
	'transport overhead is included in durationMs',
	'toolCalls and Guessless invocations reflect transcript event semantics',
	'model output is nondeterministic',
	'tasks and fixture are synthetic',
	'no causal performance claim is made',
	'unrun zero values are protocol sentinels, not performance measurements',
] as const;

function benchmarksFor(
	protocol: ReturnType<typeof loadProtocol>,
	truth: ReturnType<typeof loadGroundTruth>,
	runs: readonly RunRecord[],
): Record<string, unknown> {
	const perTask = Object.fromEntries(
		(Object.keys(TASKS) as (keyof typeof TASKS)[]).map((task) => {
			const files = protocol.inputFiles.filter((file) => file.path.startsWith(`${task}/`));
			return [
				task,
				{
					files: files.length,
					bytes: files.reduce((sum, file) => sum + file.bytes, 0),
					plantedSites: truth[task].planted.length,
				},
			];
		}),
	);
	return {
		schema: 'guessless.evaluation-benchmarks/v1',
		evidenceId: protocol.evidenceId,
		model: protocol.model,
		codexVersion: protocol.codexVersion,
		protocolSchema: protocol.schema,
		order: protocol.order,
		fixture: {
			perTask,
			total: {
				files: protocol.inputFiles.length,
				bytes: protocol.inputFiles.reduce((sum, file) => sum + file.bytes, 0),
				plantedSites: (Object.keys(TASKS) as (keyof typeof TASKS)[]).reduce(
					(sum, task) => sum + truth[task].planted.length,
					0,
				),
			},
		},
		cells: runs.map((run) => ({
			id: run.id,
			task: run.task,
			arm: run.arm,
			state: run.state,
			durationMs: run.durationMs,
			reportedTotalTokens: run.reportedTotalTokens,
			toolCalls: run.toolCalls,
			guesslessInvocations: run.guesslessInvocations,
			status: run.status,
		})),
		limitations: BENCHMARK_LIMITATIONS,
	};
}

interface FrozenAuthority {
	readonly fixtureRoot: string;
	readonly protocol: ReturnType<typeof loadProtocol>;
	readonly protocolBytes: Uint8Array;
	readonly responseSchemaBytes: Uint8Array;
	readonly truthBytes: Uint8Array;
	readonly oracleRationaleBytes?: Uint8Array;
	readonly truth: ReturnType<typeof loadGroundTruth>;
	readonly inputs: readonly { path: string; bytes: Uint8Array }[];
	readonly executable: string;
	readonly mcpCommand: string;
	readonly mcpServer: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly scratchParent: string;
}

const unsupportedCodexResponseSchemaKeywords = new Set(['uniqueItems']);

export function assertCodexResponseSchemaCompatible(bytes: Uint8Array): void {
	let schema: unknown;
	try {
		schema = JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch {
		throw new Error('response schema is not valid JSON');
	}
	const incompatible: string[] = [];
	const visit = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`);
			return;
		}
		if (value === null || typeof value !== 'object') return;
		for (const [key, item] of Object.entries(value)) {
			const itemPath = `${path}.${key}`;
			if (unsupportedCodexResponseSchemaKeywords.has(key)) incompatible.push(itemPath);
			visit(item, itemPath);
		}
	};
	visit(schema, '$');
	if (incompatible.length > 0)
		throw new Error(
			`response schema uses unsupported Codex keyword uniqueItems at ${incompatible.join(', ')}`,
		);
}

export type EvaluationRunner = (
	task: keyof typeof TASKS,
	arm: 'control' | 'guessless',
	inputRoot: string,
) => CodexRun;

function inputLedger(inputRoot: string): string {
	return stableJson(fileLedger(inputRoot));
}

export function hasRunFatalComponent(failureReason: string | undefined): boolean {
	return (
		failureReason?.split(' | ').some((component) => component.startsWith('RUN_FATAL:')) ?? false
	);
}

function canonicalUnrunRecord(cell: {
	id: string;
	task: keyof typeof TASKS;
	arm: 'control' | 'guessless';
}): RunRecord {
	return {
		id: cell.id,
		task: cell.task,
		arm: cell.arm,
		argv: [],
		environmentNames: [],
		environmentValueFingerprints: {},
		state: 'unrun',
		status: null,
		signal: null,
		timedOut: false,
		durationMs: 0,
		stdoutSha256: sha256(Buffer.alloc(0)),
		stderrSha256: sha256(Buffer.alloc(0)),
		toolCalls: 0,
		reportedTotalTokens: 0,
		guesslessInvocations: 0,
	};
}

export function executeRunSequence(
	stage: string,
	runner: EvaluationRunner,
	order: readonly {
		id: string;
		task: keyof typeof TASKS;
		arm: 'control' | 'guessless';
	}[] = ORDER,
	continueAfterInvalid = false,
): RunRecord[] {
	const raw = join(stage, 'raw');
	const inputRoot = join(stage, '.preflight/input');
	const preflightManifest = join(stage, '.preflight/manifest.json');
	const expectedManifest = readFileSync(preflightManifest, 'utf8');
	const expectedLedger = inputLedger(inputRoot);
	const runs: RunRecord[] = [];
	let failed = false;
	for (const cell of order) {
		if (failed) {
			writeNew(join(raw, `${cell.id}.stdout.jsonl`), Buffer.alloc(0));
			writeNew(join(raw, `${cell.id}.stderr.txt`), Buffer.alloc(0));
			runs.push(canonicalUnrunRecord(cell));
			continue;
		}
		let result: CodexRun;
		try {
			if (
				preflightLedger(stage) !== expectedManifest ||
				inputLedger(inputRoot) !== expectedLedger
			)
				throw new FatalEvaluationError(`${cell.id} pre-cell immutable preflight mismatch`);
			result = runner(cell.task, cell.arm, inputRoot);
			if (containsSecret(result.stdout, result.stderr))
				throw new FatalEvaluationError('runner stream contains a secret pattern');
		} catch (error) {
			if (error instanceof FatalEvaluationError && !continueAfterInvalid) throw error;
			const failureReason = error instanceof Error ? error.message : String(error);
			result = {
				argv: [],
				environmentNames: [],
				environmentValueFingerprints: {},
				status: -1,
				signal: null,
				timedOut: false,
				durationMs: 0,
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
				stdoutSha256: sha256(Buffer.alloc(0)),
				stderrSha256: sha256(Buffer.alloc(0)),
				toolCalls: 0,
				reportedTotalTokens: 0,
				guesslessInvocations: 0,
				spawnProvenance: {
					attempted: false,
					returned: false,
					thrownMessage: null,
					resultErrorMessage: null,
				},
				failureReason:
					error instanceof FatalEvaluationError
						? `RUN_FATAL: ${failureReason}`
						: failureReason,
			};
		}
		writeNew(join(raw, `${cell.id}.stdout.jsonl`), result.stdout);
		writeNew(join(raw, `${cell.id}.stderr.txt`), result.stderr);
		if (continueAfterInvalid && !hasRunFatalComponent(result.failureReason)) {
			const armReason =
				cell.arm === 'control' && result.guesslessInvocations !== 0
					? 'ARM_COMPLIANCE: control invoked Guessless'
					: cell.arm === 'guessless' && result.guesslessInvocations < 1
						? 'ARM_COMPLIANCE: treatment did not invoke Guessless'
						: undefined;
			if (armReason !== undefined)
				result = {
					...result,
					failureReason: [result.failureReason, armReason].filter(Boolean).join(' | '),
				};
		}
		const state = result.failureReason === undefined ? 'completed' : 'failed';
		const executed = {
			id: cell.id,
			task: cell.task,
			arm: cell.arm,
			argv: result.argv,
			environmentNames: result.environmentNames,
			environmentValueFingerprints: result.environmentValueFingerprints,
			status: result.status,
			signal: result.signal,
			timedOut: result.timedOut,
			durationMs: result.durationMs,
			stdoutSha256: result.stdoutSha256,
			stderrSha256: result.stderrSha256,
			toolCalls: result.toolCalls,
			reportedTotalTokens: result.reportedTotalTokens,
			guesslessInvocations: result.guesslessInvocations,
			spawnProvenance: result.spawnProvenance ?? {
				attempted: false,
				returned: false,
				thrownMessage: null,
				resultErrorMessage: null,
			},
			immutablePostflight: false,
		};
		if (state === 'completed') {
			if (
				result.status !== 0 ||
				result.signal !== null ||
				result.timedOut ||
				result.terminal === undefined
			)
				throw new Error(`${cell.id} runner returned noncanonical completion`);
			runs.push({
				...executed,
				state,
				status: 0,
				signal: null,
				timedOut: false,
				immutablePostflight: false,
				terminal: result.terminal,
			});
		} else {
			runs.push({
				...executed,
				state,
				failureReason: result.failureReason!,
				...(result.terminal === undefined ? {} : { terminal: result.terminal }),
			});
		}
		failed =
			state === 'failed' &&
			(!continueAfterInvalid || hasRunFatalComponent(result.failureReason));
		let postflightMatches = false;
		try {
			postflightMatches =
				preflightLedger(stage) === expectedManifest &&
				inputLedger(inputRoot) === expectedLedger;
		} catch {
			postflightMatches = false;
		}
		if (!postflightMatches) {
			const last = runs.at(-1);
			if (last === undefined || last.state === 'unrun')
				throw new Error('input mutation outcome missing');
			runs[runs.length - 1] = {
				...last,
				state: 'failed',
				immutablePostflight: true,
				failureReason: [
					...(last.failureReason === undefined ? [] : [last.failureReason]),
					continueAfterInvalid
						? 'RUN_FATAL: IMMUTABLE_PREFLIGHT: post-cell mismatch'
						: 'IMMUTABLE_PREFLIGHT: post-cell mismatch',
				].join(' | '),
			};
			failed = true;
		}
	}
	return runs;
}

function preflightLedger(stage: string): string {
	const root = join(stage, '.preflight');
	return stableJson({
		protocolSha256: sha256File(join(root, 'protocol.json')),
		responseSchemaSha256: sha256File(join(root, 'response.schema.json')),
		...(existsSync(join(root, 'oracle-rationale.json'))
			? { oracleRationaleSha256: sha256File(join(root, 'oracle-rationale.json')) }
			: {}),
		inputFiles: fileLedger(join(root, 'input')),
	});
}

function jsonLines(values: readonly unknown[]): string {
	return values.map((value) => stableJson(value).trimEnd()).join('\n') + '\n';
}

function writeNew(path: string, value: string | Uint8Array): void {
	writeFileSync(path, value, { flag: 'wx' });
}

function checkedFiles(evidenceId: EvidenceId): string[] {
	const order = orderFor(evidenceId);
	return [
		...([V2_EVIDENCE_ID, V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(evidenceId)
			? ['benchmarks.json']
			: []),
		...(isRepeatedEvidence(evidenceId) ? ['decision.json', 'replay.json'] : []),
		'commands.json',
		'protocol.json',
		'scores.json',
		'summary.md',
		'raw/runs.jsonl',
		'raw/calibration.jsonl',
		...order.flatMap((cell) => [`raw/${cell.id}.stdout.jsonl`, `raw/${cell.id}.stderr.txt`]),
	].sort();
}

function evidenceIdAt(root: string): EvidenceId {
	const value = JSON.parse(readFileSync(join(root, 'protocol.json'), 'utf8')) as {
		evidenceId?: unknown;
	};
	if (
		![EVIDENCE_ID, V2_EVIDENCE_ID, V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(
			value.evidenceId as EvidenceId,
		)
	)
		throw new Error('evaluation evidence identity mismatch');
	return value.evidenceId as EvidenceId;
}

function manifestFor(root: string): Record<string, unknown> {
	const evidenceId = evidenceIdAt(root);
	return {
		schema:
			evidenceId === EVIDENCE_ID
				? 'guessless.evaluation-evidence/v1'
				: evidenceId === V2_EVIDENCE_ID
					? 'guessless.evaluation-evidence/v2'
					: evidenceId === V3_EVIDENCE_ID
						? 'guessless.evaluation-evidence/v3'
						: evidenceId === V4_EVIDENCE_ID
							? 'guessless.evaluation-evidence/v4'
							: 'guessless.evaluation-evidence/v5',
		evidenceId,
		files: checkedFiles(evidenceId).map((path) => {
			const absolute = join(root, path);
			assertRealFile(absolute, path);
			return { path, bytes: statSync(absolute).size, sha256: sha256File(absolute) };
		}),
	};
}

function reseal(root: string): void {
	writeFileSync(join(root, 'manifest.json'), stableJson(manifestFor(root)));
}

export function promoteNewWithRollback(stage: string, final: string, verify: () => void): void {
	if (existsSync(final)) throw new Error('evaluation evidence already exists');
	const parent = assertRealDirectory(dirname(final), 'promotion parent');
	assertRealDirectory(stage, 'promotion stage');
	assertContained(parent, stage);
	renameSync(stage, final);
	try {
		verify();
	} catch (error) {
		if (existsSync(final)) renameSync(final, stage);
		throw error;
	}
}

function parseRuns(root: string): RunRecord[] {
	const text = readFileSync(join(root, 'raw/runs.jsonl'), 'utf8');
	if (!text.endsWith('\n')) throw new Error('runs ledger lacks terminal LF');
	return text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as RunRecord);
}

function verifyProtocol(protocol: unknown, expected: ReturnType<typeof loadProtocol>): void {
	if (stableJson(protocol) !== stableJson(expected))
		throw new Error('evaluation protocol mismatch');
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
	if (stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort()))
		throw new Error(`${label} keys mismatch`);
}

function assertSpawnProvenance(value: SpawnProvenance, label: string): void {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error(`${label} spawn provenance mismatch`);
	assertExactKeys(
		value,
		['attempted', 'returned', 'thrownMessage', 'resultErrorMessage'],
		`${label} spawn provenance`,
	);
	if (
		value.attempted !== true ||
		typeof value.returned !== 'boolean' ||
		(value.thrownMessage !== null && typeof value.thrownMessage !== 'string') ||
		(value.resultErrorMessage !== null && typeof value.resultErrorMessage !== 'string') ||
		(!value.returned && value.resultErrorMessage !== null)
	)
		throw new Error(`${label} spawn provenance mismatch`);
}

const runIdentityKeys = [
	'id',
	'task',
	'arm',
	'state',
	'argv',
	'environmentNames',
	'environmentValueFingerprints',
	'status',
	'signal',
	'timedOut',
	'durationMs',
	'stdoutSha256',
	'stderrSha256',
	'toolCalls',
	'reportedTotalTokens',
	'guesslessInvocations',
] as const;

const executedRunKeys = [...runIdentityKeys, 'spawnProvenance', 'immutablePostflight'] as const;

function verifyRoot(
	root: string,
	protocolAuthority?: ReturnType<typeof loadProtocol>,
	truthAuthority?: ReturnType<typeof loadGroundTruth>,
	executionAuthority?: FrozenAuthority,
): void {
	assertRealDirectory(root, 'evaluation evidence');
	const evidenceId = evidenceIdAt(root);
	const fixtureRoot = paths(undefined, evidenceId).fixtureRoot;
	protocolAuthority ??= loadProtocol(fixtureRoot);
	truthAuthority ??= loadGroundTruth(fixtureRoot);
	const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
	if (stableJson(manifest) !== stableJson(manifestFor(root)))
		throw new Error('evaluation manifest mismatch');
	const protocol = JSON.parse(readFileSync(join(root, 'protocol.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	verifyProtocol(protocol, protocolAuthority);
	const runs = parseRuns(root);
	const order = orderFor(evidenceId);
	if (
		runs.length !== order.length ||
		runs.some(
			(run, index) =>
				run.id !== order[index].id ||
				run.task !== order[index].task ||
				run.arm !== order[index].arm,
		)
	)
		throw new Error('evaluation run order mismatch');
	for (const [index, run] of runs.entries()) {
		const rawRun = run as unknown as Record<string, unknown>;
		if (!['completed', 'failed', 'unrun'].includes(String(rawRun.state)))
			throw new Error(`${run.id} unknown run state`);
		const stdout = readFileSync(join(root, 'raw', `${run.id}.stdout.jsonl`));
		const stderr = readFileSync(join(root, 'raw', `${run.id}.stderr.txt`));
		if (sha256(stdout) !== run.stdoutSha256 || sha256(stderr) !== run.stderrSha256)
			throw new Error(`${run.id} transcript hash mismatch`);
		if (
			![
				run.toolCalls,
				run.reportedTotalTokens,
				run.guesslessInvocations,
				run.durationMs,
			].every((value) => Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0)
		)
			throw new Error(`${run.id} count/duration must be a finite nonnegative safe integer`);
		if (run.state === 'unrun') {
			const canonicalUnrun = canonicalUnrunRecord(order[index]!);
			if (
				stdout.length !== 0 ||
				stderr.length !== 0 ||
				stableJson(run) !== stableJson(canonicalUnrun)
			)
				throw new Error(`${run.id} unrun outcome mismatch`);
			continue;
		}
		assertSpawnProvenance(run.spawnProvenance, run.id);
		if (typeof run.immutablePostflight !== 'boolean')
			throw new Error(`${String(rawRun.id)} immutablePostflight boolean mismatch`);
		if (
			!Number.isSafeInteger(run.status) ||
			(run.signal !== null && (typeof run.signal !== 'string' || run.signal.length === 0)) ||
			typeof run.timedOut !== 'boolean' ||
			run.timedOut !==
				(run.spawnProvenance.resultErrorMessage?.includes('ETIMEDOUT') ?? false)
		)
			throw new Error(`${run.id} process metadata mismatch`);
		if (run.state === 'completed') {
			assertExactKeys(run, [...executedRunKeys, 'terminal'], run.id);
			if (
				run.status !== 0 ||
				run.signal !== null ||
				run.timedOut ||
				run.immutablePostflight ||
				!run.spawnProvenance.returned ||
				run.spawnProvenance.thrownMessage !== null ||
				run.spawnProvenance.resultErrorMessage !== null ||
				run.toolCalls > protocolAuthority.budgets.maxToolCalls ||
				('maxReportedTotalTokens' in protocolAuthority.budgets &&
					run.reportedTotalTokens > protocolAuthority.budgets.maxReportedTotalTokens)
			)
				throw new Error(`${run.id} completed outcome mismatch`);
			const replayed = replayCodexTranscript(
				stdout,
				[V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(evidenceId) ? 'v4' : 'legacy',
			);
			if (evidenceId === V5_EVIDENCE_ID) validateV5Response(run.task, replayed.terminal);
			if (
				(evidenceId === V3_EVIDENCE_ID && replayed.terminalMessages !== 1) ||
				stableJson(replayed.terminal) !== stableJson(run.terminal) ||
				replayed.toolCalls !== run.toolCalls ||
				replayed.reportedTotalTokens !== run.reportedTotalTokens ||
				replayed.guesslessInvocations !== run.guesslessInvocations
			)
				throw new Error(`${run.id} transcript replay mismatch`);
		}
		if (run.state === 'failed') {
			assertExactKeys(
				run,
				[
					...executedRunKeys,
					'failureReason',
					...(run.terminal === undefined ? [] : ['terminal']),
				],
				run.id,
			);
			if (
				isRepeatedEvidence(evidenceId) &&
				[
					`RUN_FATAL: ${run.id} pre-cell immutable preflight mismatch`,
					'RUN_FATAL: runner stream contains a secret pattern',
					'RUN_FATAL: captured Codex stream contains a secret pattern',
				].includes(run.failureReason)
			) {
				if (
					run.argv.length !== 0 ||
					run.status !== -1 ||
					run.spawnProvenance.attempted ||
					stdout.length !== 0 ||
					stderr.length !== 0
				)
					throw new Error(`${run.id} preflight fatal outcome mismatch`);
				continue;
			}
			const replayed = inspectCodexTranscript(
				stdout,
				[V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(evidenceId) ? 'v4' : 'legacy',
			);
			if (
				replayed.toolCalls !== run.toolCalls ||
				replayed.reportedTotalTokens !== run.reportedTotalTokens ||
				replayed.guesslessInvocations !== run.guesslessInvocations ||
				stableJson(replayed.terminal ?? null) !== stableJson(run.terminal ?? null)
			)
				throw new Error(`${run.id} failed transcript replay mismatch`);
			const expectedReasons: string[] = [];
			if (run.spawnProvenance.thrownMessage !== null)
				expectedReasons.push(`TRANSPORT: ${run.spawnProvenance.thrownMessage}`);
			if (!run.spawnProvenance.returned)
				expectedReasons.push('NO_RESULT: spawn returned no result');
			if (run.status !== 0) expectedReasons.push(`PROCESS_STATUS: ${run.status}`);
			if (run.signal !== null) expectedReasons.push(`SIGNAL: ${run.signal}`);
			if (run.timedOut) expectedReasons.push('TIMEOUT: true');
			if (run.spawnProvenance.resultErrorMessage !== null)
				expectedReasons.push(`TRANSPORT_ERROR: ${run.spawnProvenance.resultErrorMessage}`);
			if (replayed.error !== undefined) expectedReasons.push(`TRANSCRIPT: ${replayed.error}`);
			if (evidenceId === V5_EVIDENCE_ID && replayed.terminal !== undefined)
				try {
					validateV5Response(run.task, replayed.terminal);
				} catch (error) {
					expectedReasons.push(
						`RESPONSE_CONTRACT: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			if (evidenceId === V3_EVIDENCE_ID && replayed.terminalMessages !== 1)
				expectedReasons.push(
					`TRANSCRIPT: Codex terminal agent message count mismatch: ${replayed.terminalMessages}`,
				);
			if (replayed.error === 'Codex token sum exceeds safe integer range')
				expectedReasons.push('UNSAFE_TOKEN_SUM: true');
			if (replayed.toolCalls > protocolAuthority.budgets.maxToolCalls)
				expectedReasons.push(
					`TOOL_BUDGET_EXCEEDED: ${replayed.toolCalls}>${protocolAuthority.budgets.maxToolCalls}`,
				);
			if (
				'maxReportedTotalTokens' in protocolAuthority.budgets &&
				replayed.reportedTotalTokens > protocolAuthority.budgets.maxReportedTotalTokens
			)
				expectedReasons.push(
					`TOKEN_BUDGET_EXCEEDED: ${replayed.reportedTotalTokens}>${protocolAuthority.budgets.maxReportedTotalTokens}`,
				);
			if (run.immutablePostflight)
				expectedReasons.push(
					isRepeatedEvidence(evidenceId)
						? 'RUN_FATAL: IMMUTABLE_PREFLIGHT: post-cell mismatch'
						: 'IMMUTABLE_PREFLIGHT: post-cell mismatch',
				);
			if (isRepeatedEvidence(evidenceId)) {
				if (run.arm === 'control' && replayed.guesslessInvocations !== 0)
					expectedReasons.push('ARM_COMPLIANCE: control invoked Guessless');
				if (run.arm === 'guessless' && replayed.guesslessInvocations < 1)
					expectedReasons.push('ARM_COMPLIANCE: treatment did not invoke Guessless');
			}
			if (expectedReasons.length === 0)
				throw new Error(`${run.id} fabricated failed outcome`);
			if (run.failureReason !== expectedReasons.join(' | '))
				throw new Error(`${run.id} cumulative failure classification mismatch`);
		}
		{
			const mcp = exactMcpArguments(run.argv);
			const hasGuessless = mcp.length > 0;
			if (hasGuessless !== (run.arm === 'guessless'))
				throw new Error(`${run.id} tool-arm mismatch`);
			if (run.arm === 'control' && run.guesslessInvocations !== 0)
				throw new Error(`${run.id} control transcript invoked Guessless`);
			if (
				isRepeatedEvidence(evidenceId) &&
				run.state === 'completed' &&
				run.arm === 'guessless' &&
				run.guesslessInvocations < 1
			)
				throw new Error(`${run.id} treatment transcript did not invoke Guessless`);
			if (
				stableJson(run.environmentNames) !==
					stableJson(['HOME', 'LANG', 'PATH', 'TMPDIR']) ||
				stableJson(Object.keys(run.environmentValueFingerprints).sort()) !==
					stableJson(['HOME', 'LANG', 'PATH', 'TMPDIR']) ||
				run.environmentValueFingerprints.LANG !== sha256('C.UTF-8') ||
				run.environmentValueFingerprints.PATH !== sha256('/usr/bin:/bin:/usr/sbin:/sbin')
			)
				throw new Error(`${run.id} child environment contract mismatch`);
			if (executionAuthority !== undefined) {
				if (run.argv[0] !== executionAuthority.executable)
					throw new Error(`${run.id} executable mismatch`);
				const expectedFingerprints = Object.fromEntries(
					Object.entries(executionAuthority.environment).map(([name, value]) => [
						name,
						sha256(String(value)),
					]),
				);
				if (
					stableJson(run.environmentValueFingerprints) !==
					stableJson(expectedFingerprints)
				)
					throw new Error(`${run.id} frozen environment fingerprint mismatch`);
				const scratch = run.argv[run.argv.indexOf('-C') + 1];
				const schema = run.argv[run.argv.indexOf('--output-schema') + 1];
				if (
					scratch === undefined ||
					schema === undefined ||
					!isAbsolute(scratch) ||
					!isAbsolute(schema) ||
					!scratch.startsWith(`${executionAuthority.scratchParent}${sep}`)
				)
					throw new Error(`${run.id} absolute schema/scratch path mismatch`);
				const expectedMcp = [
					`mcp_servers.guessless.command=${JSON.stringify(executionAuthority.mcpCommand)}`,
					`mcp_servers.guessless.args=[${JSON.stringify(executionAuthority.mcpServer)}]`,
				];
				if (run.arm === 'guessless' && stableJson(mcp) !== stableJson(expectedMcp))
					throw new Error(`${run.id} exact MCP argv mismatch`);
			}
			const expectedNormalized = [
				run.argv[0]!,
				'exec',
				'--ephemeral',
				'--ignore-user-config',
				'--ignore-rules',
				'--skip-git-repo-check',
				'--sandbox',
				'read-only',
				'--model',
				protocolAuthority.model,
				'--output-schema',
				'<schema>',
				'--json',
				'-C',
				'<scratch>',
				'-c',
				`developer_instructions=${JSON.stringify(protocolAuthority.systemInstruction)}`,
				protocolAuthority.tasks[run.task],
			];
			if (stableJson(normalizedArgv(run.argv)) !== stableJson(expectedNormalized))
				throw new Error(`${run.id} exact argv mismatch`);
		}
		if (containsSecret(stdout, stderr))
			throw new Error(`${run.id} transcript contains secret pattern`);
	}
	const executed = runs.filter((run) => run.state !== 'unrun');
	if (
		executed.some(
			(run) =>
				stableJson(run.environmentNames) !== stableJson(executed[0]?.environmentNames) ||
				stableJson(run.environmentValueFingerprints) !==
					stableJson(executed[0]?.environmentValueFingerprints),
		)
	)
		throw new Error('evaluation child environment mismatch');
	for (const task of Object.keys(TASKS) as (keyof typeof TASKS)[]) {
		const pair = executed.filter((run) => run.task === task);
		if (
			pair.length === 2 &&
			stableJson(normalizedArgv(pair[0]!.argv)) !== stableJson(normalizedArgv(pair[1]!.argv))
		)
			throw new Error(`${task} paired argv mismatch beyond Guessless MCP treatment`);
	}
	if (isRepeatedEvidence(evidenceId))
		for (let index = 0; index < runs.length; index += 2) {
			const pair = runs.slice(index, index + 2).filter((run) => run.state !== 'unrun');
			if (
				pair.length === 2 &&
				stableJson(normalizedArgv(pair[0]!.argv)) !==
					stableJson(normalizedArgv(pair[1]!.argv))
			)
				throw new Error(`${pair[0]!.id} paired argv mismatch beyond Guessless treatment`);
		}
	const failedIndices = runs.flatMap((run, index) => (run.state === 'failed' ? [index] : []));
	const allCompleted = runs.every((run) => run.state === 'completed');
	const failedIndex = failedIndices[0] ?? -1;
	const canonicalPartial =
		failedIndices.length === 1 &&
		failedIndex >= 0 &&
		runs.slice(0, failedIndex).every((run) => run.state === 'completed') &&
		runs[failedIndex]?.state === 'failed' &&
		runs.slice(failedIndex + 1).every((run) => run.state === 'unrun');
	const fatalIndices = runs.flatMap((run, index) =>
		run.state === 'failed' && hasRunFatalComponent(run.failureReason) ? [index] : [],
	);
	const fatalIndex = fatalIndices[0] ?? -1;
	const v3FatalPartial =
		isRepeatedEvidence(evidenceId) &&
		fatalIndices.length === 1 &&
		fatalIndex >= 0 &&
		runs.slice(0, fatalIndex).every((run) => run.state !== 'unrun') &&
		runs[fatalIndex]?.state === 'failed' &&
		runs.slice(fatalIndex + 1).every((run) => run.state === 'unrun');
	const v3Continued =
		isRepeatedEvidence(evidenceId) &&
		fatalIndices.length === 0 &&
		runs.every((run) => run.state !== 'unrun');
	const acceptedLegacyPartial = !isRepeatedEvidence(evidenceId) && canonicalPartial;
	if (!allCompleted && !acceptedLegacyPartial && !v3Continued && !v3FatalPartial)
		throw new Error('evaluation run topology mismatch');
	const truth = truthAuthority;
	const rescored = runs
		.filter((run) => run.state === 'completed' && run.terminal !== undefined)
		.map((run) =>
			isRepeatedEvidence(evidenceId)
				? scoreV3Cell(run.task, run.arm, run.terminal!, truth)
				: scoreCell(run.task, run.arm, run.terminal!, truth),
		);
	const scores = JSON.parse(readFileSync(join(root, 'scores.json'), 'utf8')) as ScoresFile;
	const v3Analysis = isRepeatedEvidence(evidenceId) ? v3AnalysisFor(runs, truth) : undefined;
	const pairedScores = isRepeatedEvidence(evidenceId)
		? v3CompletePairScores(runs, truth)
		: completePairs(rescored);
	if (
		stableJson(scores) !==
		stableJson({
			cells: rescored,
			pairedTotals: aggregate(pairedScores),
			...(v3Analysis === undefined ? {} : { analysis: v3Analysis }),
		})
	)
		throw new Error('evaluation score mismatch');
	const commands = JSON.parse(readFileSync(join(root, 'commands.json'), 'utf8')) as {
		model: string;
		codexVersion: string;
		runs: readonly {
			id: string;
			argv: readonly string[];
			environmentNames: readonly string[];
			environmentValueFingerprints: Readonly<Record<string, string>>;
		}[];
	};
	if (
		commands.model !== MODEL ||
		commands.codexVersion !== CODEX_VERSION ||
		stableJson(commands.runs) !==
			stableJson(
				runs.map((run) => ({
					id: run.id,
					argv: run.argv,
					environmentNames: run.environmentNames,
					environmentValueFingerprints: run.environmentValueFingerprints,
				})),
			)
	)
		throw new Error('evaluation command ledger mismatch');
	if (evidenceId === V2_EVIDENCE_ID) {
		const benchmarks = JSON.parse(readFileSync(join(root, 'benchmarks.json'), 'utf8'));
		if (stableJson(benchmarks) !== stableJson(benchmarksFor(protocolAuthority, truth, runs)))
			throw new Error('evaluation benchmarks mismatch');
	}
	if (isRepeatedEvidence(evidenceId)) {
		const benchmarks = JSON.parse(readFileSync(join(root, 'benchmarks.json'), 'utf8'));
		if (
			stableJson(benchmarks) !==
			stableJson(v3BenchmarksFor(protocolAuthority, truth, runs, v3Analysis!))
		)
			throw new Error('evaluation benchmarks mismatch');
		const decision = JSON.parse(readFileSync(join(root, 'decision.json'), 'utf8'));
		if (
			stableJson(decision) !==
			stableJson({
				schema: `guessless.evaluation-decision/${repeatedVersion(evidenceId)}`,
				evidenceId,
				decision: v3Analysis!.decision,
				analysis: v3Analysis,
				scope: 'reversible sibling-repository integration',
			})
		)
			throw new Error('evaluation decision mismatch');
		const replay = JSON.parse(readFileSync(join(root, 'replay.json'), 'utf8'));
		if (
			stableJson(replay) !==
			stableJson({
				schema: `guessless.evaluation-replay/${repeatedVersion(evidenceId)}`,
				evidenceId,
				runCount: runs.length,
				transcriptAggregateSha256: sha256(
					stableJson(
						runs.map((run) => ({
							id: run.id,
							stdoutSha256: run.stdoutSha256,
							stderrSha256: run.stderrSha256,
						})),
					),
				),
				analysis: v3Analysis,
			})
		)
			throw new Error('evaluation replay mismatch');
	}
}

function completePairs(cells: readonly CellScore[]): CellScore[] {
	return cells.filter(
		(cell) =>
			cells.some((peer) => peer.task === cell.task && peer.arm !== cell.arm) &&
			cells.filter((peer) => peer.task === cell.task).length === 2,
	);
}

function v3CompletePairScores(
	runs: readonly RunRecord[],
	truth: ReturnType<typeof loadGroundTruth>,
): CellScore[] {
	const result: CellScore[] = [];
	for (let index = 0; index < runs.length; index += 2) {
		const pair = runs.slice(index, index + 2);
		if (pair.length !== 2 || pair.some((run) => run.state !== 'completed')) continue;
		for (const run of pair) result.push(scoreV3Cell(run.task, run.arm, run.terminal!, truth));
	}
	return result;
}

function normalizedArgv(argv: readonly string[]): string[] {
	const exactMcp = new Set(exactMcpArguments(argv));
	const normalized: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]!;
		if (value === '-C' || value === '--output-schema') {
			normalized.push(value, `<${value === '-C' ? 'scratch' : 'schema'}>`);
			index += 1;
			continue;
		}
		if (value === '-c' && exactMcp.has(argv[index + 1] ?? '')) {
			index += 1;
			continue;
		}
		normalized.push(value);
	}
	return normalized;
}

function exactMcpArguments(argv: readonly string[]): string[] {
	const values = argv.filter((value) => value.includes('mcp_servers.guessless'));
	if (values.length === 0) return [];
	if (
		values.length !== 2 ||
		!/^mcp_servers\.guessless\.command="\/[^"\n]+"$/.test(values[0] ?? '') ||
		!/^mcp_servers\.guessless\.args=\["\/[^"\n]+"\]$/.test(values[1] ?? '')
	)
		throw new Error('malformed Guessless MCP argv treatment');
	for (const value of values) {
		const index = argv.indexOf(value);
		if (index < 1 || argv[index - 1] !== '-c')
			throw new Error('Guessless MCP argv lacks exact config pairing');
	}
	return values;
}

interface CalibrationRecord {
	readonly guard: string;
	readonly expectedRed: boolean;
	readonly restorationByteIdentical: boolean;
	readonly evidence: string;
}

function fixtureCalibrations(evidenceId: EvidenceId = EVIDENCE_ID): CalibrationRecord[] {
	if (evidenceId === V3_EVIDENCE_ID) return v3FixtureCalibrations();
	if (evidenceId === V4_EVIDENCE_ID) return v4FixtureCalibrations();
	if (evidenceId === V5_EVIDENCE_ID) return v5FixtureCalibrations();
	const fixtureRoot = paths(undefined, evidenceId).fixtureRoot;
	proveGroundTruth(fixtureRoot);
	const original = loadProtocol(fixtureRoot);
	const records: CalibrationRecord[] = [];
	const check = (guard: string, action: () => void): void => {
		const before = stableJson(fileLedger(fixtureRoot));
		let evidence = '';
		try {
			action();
		} catch (error) {
			evidence = error instanceof Error ? error.message : String(error);
		}
		records.push({
			guard,
			expectedRed: evidence.length > 0,
			restorationByteIdentical: before === stableJson(fileLedger(fixtureRoot)),
			evidence,
		});
	};
	for (const [guard, mutate] of [
		['protocol', (value: any) => (value.schema = 'wrong')],
		['model', (value: any) => (value.model = 'wrong')],
		['prompt', (value: any) => (value.tasks.rename += ' hint')],
		['input', (value: any) => (value.inputFiles[0].sha256 = '0'.repeat(64))],
		['tool', (value: any) => value.codexFlags.push('--search')],
		['budget', (value: any) => (value.budgets.maxToolCalls = 17)],
		['scoring', (value: any) => (value.scoring.aggregation = 'subjective')],
		['protocol-extra', (value: any) => (value.unexpected = true)],
		['order', (value: any) => value.order.reverse()],
		['response-schema', (value: any) => (value.responseSchemaSha256 = '0'.repeat(64))],
	] as const)
		check(guard, () => {
			const temp = mkdtempSync(join(realpathSync(tmpdir()), 'structural-eval-protocol-'));
			try {
				cpSync(fixtureRoot, temp, { recursive: true });
				const protocolPath = join(temp, 'protocol.json');
				const value = JSON.parse(readFileSync(protocolPath, 'utf8'));
				mutate(value);
				writeFileSync(protocolPath, stableJson(value));
				loadProtocol(temp);
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		});
	check('ground-truth', () => {
		const temp = mkdtempSync(join(realpathSync(tmpdir()), 'structural-eval-truth-'));
		try {
			cpSync(fixtureRoot, temp, { recursive: true });
			const truthPath = join(temp, 'ground-truth.json');
			const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
			truth.reach.unresolved.pop();
			writeFileSync(truthPath, stableJson(truth));
			proveReceiptGroundTruth(truth, join(temp, 'input'));
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
	const calibrateSequence = (failedAt: number | null): void => {
		const temp = mkdtempSync(join(realpathSync(tmpdir()), 'structural-eval-sequence-'));
		try {
			const config = paths(undefined, evidenceId);
			const authority = freezeAuthority(config.fixtureRoot, '/canonical/codex', config.root);
			const expectRunMutationRejected = (
				source: string,
				label: string,
				mutate: (runs: any[]) => void,
				expectedError?: string,
			): void => {
				const copy = join(temp, `expected-red-${label}`);
				cpSync(source, copy, { recursive: true });
				const runsPath = join(copy, 'raw/runs.jsonl');
				const mutatedRuns = readFileSync(runsPath, 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line));
				mutate(mutatedRuns);
				writeFileSync(runsPath, jsonLines(mutatedRuns));
				reseal(copy);
				let rejection = '';
				try {
					verifyRoot(copy, authority.protocol, authority.truth, authority);
				} catch (error) {
					rejection = error instanceof Error ? error.message : String(error);
				}
				if (rejection.length === 0) throw new Error(`${label} run mutation was accepted`);
				if (expectedError !== undefined && rejection !== expectedError)
					throw new Error(`${label} rejected for ${rejection}`);
			};
			const expectSynchronizedBundleRejected = (
				source: string,
				label: string,
				mutate: (copy: string, runs: any[]) => CellScore[],
				expectedError: string,
			): void => {
				const copy = join(temp, `expected-red-${label}`);
				cpSync(source, copy, { recursive: true });
				const runsPath = join(copy, 'raw/runs.jsonl');
				const mutatedRuns = readFileSync(runsPath, 'utf8')
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line));
				const cells = mutate(copy, mutatedRuns);
				writeFileSync(runsPath, jsonLines(mutatedRuns));
				const commandsPath = join(copy, 'commands.json');
				const commands = JSON.parse(readFileSync(commandsPath, 'utf8'));
				commands.runs = mutatedRuns.map((run) => ({
					id: run.id,
					argv: run.argv,
					environmentNames: run.environmentNames,
					environmentValueFingerprints: run.environmentValueFingerprints,
				}));
				writeFileSync(commandsPath, stableJson(commands));
				writeFileSync(
					join(copy, 'scores.json'),
					stableJson({ cells, pairedTotals: aggregate(completePairs(cells)) }),
				);
				reseal(copy);
				let rejection = '';
				try {
					verifyRoot(copy, authority.protocol, authority.truth, authority);
				} catch (error) {
					rejection = error instanceof Error ? error.message : String(error);
				}
				if (rejection !== expectedError)
					throw new Error(
						`${label} expected ${expectedError} but received ${rejection || 'acceptance'}`,
					);
			};
			let calls = 0;
			const spawner = ((command, argv, spawnOptions) => {
				const index = calls++;
				if (
					command !== authority.executable ||
					stableJson(spawnOptions?.env) !== stableJson(authority.environment)
				)
					throw new Error('sentinel observed non-authoritative command or environment');
				const prompt = argv?.at(-1);
				const task = (Object.keys(authority.protocol.tasks) as (keyof typeof TASKS)[]).find(
					(candidate) => authority.protocol.tasks[candidate] === prompt,
				);
				if (task === undefined) throw new Error('sentinel task prompt mismatch');
				const arm = argv?.some((value) => value.includes('mcp_servers.guessless.command='))
					? 'guessless'
					: 'control';
				const terminal = {
					status: 'complete' as const,
					reportedSiteIds: authority.truth[task].planted,
					unresolvedSiteIds: authority.truth[task].unresolved,
					reasoning: 'fixture runner',
				};
				const stdout = Buffer.from(
					jsonLines([
						...(arm === 'guessless'
							? [
									{
										type: 'item.started',
										item: { type: 'mcp_tool_call', server: 'guessless' },
									},
								]
							: []),
						...(index === failedAt
							? []
							: [
									{
										type: 'item.completed',
										item: {
											type: 'agent_message',
											text: JSON.stringify(terminal),
										},
									},
								]),
						{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } },
					]),
				);
				const stderr = Buffer.from(index === failedAt ? 'fixture transport failure\n' : '');
				return {
					pid: 10_000 + index,
					output: [null, stdout, stderr],
					stdout,
					stderr,
					status: index === failedAt ? 1 : 0,
					signal: null,
				} as ReturnType<CellSpawner>;
			}) as CellSpawner;
			const runs = productionPipeline({
				stage: join(temp, 'stage'),
				final: join(temp, 'final'),
				authority,
				includeEvidenceCalibration: false,
				spawner,
			});
			const expectedCalls = failedAt === null ? 6 : failedAt + 1;
			const valid =
				calls === expectedCalls &&
				(failedAt === null
					? runs.every((run) => run.state === 'completed')
					: runs.slice(0, failedAt).every((run) => run.state === 'completed') &&
						runs[failedAt]?.state === 'failed' &&
						runs.slice(failedAt + 1).every((run) => run.state === 'unrun'));
			if (!valid) throw new Error('production sequence outcome mismatch');
			const mutations = evidenceCalibrations(join(temp, 'final'), false);
			if (
				mutations.some(
					(mutation) => !mutation.expectedRed || !mutation.restorationByteIdentical,
				)
			)
				throw new Error('production evidence mutation was accepted or not restored');
			if (failedAt === null) {
				const callsBeforeOverwrite = calls;
				let overwriteRejected = false;
				try {
					productionPipeline({
						stage: join(temp, 'overwrite-stage'),
						final: join(temp, 'final'),
						authority,
						includeEvidenceCalibration: false,
						spawner,
					});
				} catch {
					overwriteRejected = true;
				}
				if (!overwriteRejected || calls !== callsBeforeOverwrite)
					throw new Error('production overwrite guard spawned or accepted replacement');
				const rollbackStage = join(temp, 'rollback-stage');
				const rollbackFinal = join(temp, 'rollback-final');
				let rollbackRejected = false;
				try {
					productionPipeline({
						stage: rollbackStage,
						final: rollbackFinal,
						authority,
						includeEvidenceCalibration: false,
						spawner,
						postPromotionVerify: (promoted) =>
							assertRealFile(join(promoted, 'missing-sentinel'), 'rollback sentinel'),
					});
				} catch {
					rollbackRejected = true;
				}
				if (!rollbackRejected || !existsSync(rollbackStage) || existsSync(rollbackFinal))
					throw new Error('production pipeline rollback failed');
				for (const target of [
					'protocol.json',
					'response.schema.json',
					'input/rename/api.ts',
				] as const) {
					const mutationStage = join(
						temp,
						`mutation-${target.replaceAll('/', '-')}-stage`,
					);
					const mutationFinal = join(
						temp,
						`mutation-${target.replaceAll('/', '-')}-final`,
					);
					let mutationCalls = 0;
					const capturedStdout: Buffer[] = [];
					const capturedStderr: Buffer[] = [];
					const mutatingSpawner = ((...spawnArgs: Parameters<CellSpawner>) => {
						const result = spawner(...spawnArgs);
						capturedStdout.push(Buffer.from(result.stdout ?? Buffer.alloc(0)));
						capturedStderr.push(Buffer.from(result.stderr ?? Buffer.alloc(0)));
						const mutationCall = mutationCalls++ === 1;
						if (mutationCall)
							writeFileSync(
								join(mutationStage, '.preflight', target),
								Buffer.from('mutated'),
							);
						return mutationCall ? { ...result, status: 86 } : result;
					}) as CellSpawner;
					const mutationRuns = productionPipeline({
						stage: mutationStage,
						final: mutationFinal,
						authority,
						includeEvidenceCalibration: false,
						spawner: mutatingSpawner,
					});
					const replayedMutation = replayCodexTranscript(
						readFileSync(
							join(mutationFinal, 'raw', `${mutationRuns[1]?.id}.stdout.jsonl`),
						),
					);
					const mutationScores = JSON.parse(
						readFileSync(join(mutationFinal, 'scores.json'), 'utf8'),
					) as ScoresFile;
					const mutationRun = mutationRuns[1];
					if (
						mutationCalls !== 2 ||
						mutationRuns[0]?.state !== 'completed' ||
						mutationRun?.state !== 'failed' ||
						mutationRun.status !== 86 ||
						mutationRuns.slice(2).some((run) => run.state !== 'unrun') ||
						stableJson(parseRuns(mutationFinal)) !== stableJson(mutationRuns) ||
						capturedStdout.some(
							(stdout, index) =>
								!stdout.equals(
									readFileSync(
										join(
											mutationFinal,
											'raw',
											`${mutationRuns[index]?.id}.stdout.jsonl`,
										),
									),
								),
						) ||
						capturedStderr.some(
							(stderr, index) =>
								!stderr.equals(
									readFileSync(
										join(
											mutationFinal,
											'raw',
											`${mutationRuns[index]?.id}.stderr.txt`,
										),
									),
								),
						) ||
						replayedMutation.toolCalls !== mutationRun.toolCalls ||
						replayedMutation.reportedTotalTokens !== mutationRun.reportedTotalTokens ||
						replayedMutation.guesslessInvocations !==
							mutationRun.guesslessInvocations ||
						stableJson(replayedMutation.terminal) !==
							stableJson(mutationRun.terminal) ||
						mutationRun.failureReason !==
							'PROCESS_STATUS: 86 | IMMUTABLE_PREFLIGHT: post-cell mismatch' ||
						!mutationRun.immutablePostflight ||
						mutationScores.cells.length !== 1 ||
						stableJson(mutationScores.pairedTotals) !== stableJson(aggregate([]))
					)
						throw new Error(`${target} between-cell mutation was not durably sealed`);
					for (const [reasonIndex, reason] of mutationRun.failureReason
						.split(' | ')
						.entries())
						expectRunMutationRejected(
							mutationFinal,
							`postflight-${target.replaceAll('/', '-')}-reason-${reasonIndex}`,
							(records) => {
								records[1].failureReason = records[1].failureReason
									.split(' | ')
									.filter((candidate: string) => candidate !== reason)
									.join(' | ');
							},
						);
					if (target === 'protocol.json') {
						expectRunMutationRejected(
							mutationFinal,
							'postflight-coordinated-completed',
							(records) => {
								records[1].state = 'completed';
								records[1].status = 0;
								records[1].immutablePostflight = false;
								delete records[1].failureReason;
							},
						);
						expectRunMutationRejected(
							mutationFinal,
							'postflight-unknown-state',
							(records) => {
								records[1].state = 'unknown';
							},
						);
						expectRunMutationRejected(
							mutationFinal,
							'postflight-dirty-unrun',
							(records) => {
								records[2].durationMs = 1;
							},
						);
					}
				}
				const firstTerminal = {
					status: 'complete' as const,
					reportedSiteIds: authority.truth.rename.planted,
					unresolvedSiteIds: authority.truth.rename.unresolved,
					reasoning: 'failure probe',
				};
				const validFailureStdout = Buffer.from(
					jsonLines([
						{
							type: 'item.completed',
							item: { type: 'agent_message', text: JSON.stringify(firstTerminal) },
						},
						{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } },
					]),
				);
				const budgetStdout = Buffer.from(
					jsonLines([
						...Array.from(
							{ length: authority.protocol.budgets.maxToolCalls + 1 },
							() => ({
								type: 'item.started',
								item: { type: 'command_execution', command: ['true'] },
							}),
						),
						{
							type: 'item.completed',
							item: { type: 'agent_message', text: JSON.stringify(firstTerminal) },
						},
						{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } },
					]),
				);
				const tokenBudgetStdout = Buffer.from(
					jsonLines([
						{
							type: 'item.completed',
							item: { type: 'agent_message', text: JSON.stringify(firstTerminal) },
						},
						{
							type: 'turn.completed',
							usage: {
								input_tokens:
									('maxReportedTotalTokens' in authority.protocol.budgets
										? authority.protocol.budgets.maxReportedTotalTokens
										: 16_000) + 1,
								output_tokens: 0,
							},
						},
					]),
				);
				const unsafeTokenSumStdout = Buffer.from(
					jsonLines([
						{
							type: 'item.completed',
							item: { type: 'agent_message', text: JSON.stringify(firstTerminal) },
						},
						{
							type: 'turn.completed',
							usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
						},
					]),
				);
				const overbudgetPrefixWithInvalidSuffix = Buffer.concat([
					Buffer.from(
						jsonLines(
							Array.from(
								{ length: authority.protocol.budgets.maxToolCalls + 1 },
								() => ({
									type: 'item.started',
									item: { type: 'command_execution', command: ['true'] },
								}),
							),
						),
					),
					Buffer.from('{invalid-json\n'),
				]);
				const failureCases: readonly [string, () => ReturnType<CellSpawner>, boolean][] = [
					[
						'throw',
						() => {
							throw new Error('sentinel spawn throw');
						},
						false,
					],
					[
						'null-streams',
						() =>
							({
								pid: 1,
								output: [null, null, null],
								stdout: null,
								stderr: null,
								status: 0,
								signal: null,
							}) as unknown as ReturnType<CellSpawner>,
						false,
					],
					[
						'invalid-json',
						() =>
							({
								pid: 1,
								output: [null, Buffer.from('{bad\n'), Buffer.alloc(0)],
								stdout: Buffer.from('{bad\n'),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'invalid-utf8',
						() =>
							({
								pid: 1,
								output: [null, Buffer.from([0xff, 0x0a]), Buffer.alloc(0)],
								stdout: Buffer.from([0xff, 0x0a]),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'budget',
						() =>
							({
								pid: 1,
								output: [null, budgetStdout, Buffer.alloc(0)],
								stdout: budgetStdout,
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'nonzero-budget',
						() =>
							({
								pid: 1,
								output: [null, budgetStdout, Buffer.alloc(0)],
								stdout: budgetStdout,
								stderr: Buffer.alloc(0),
								status: 1,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'timeout-budget',
						() =>
							({
								pid: 1,
								output: [null, budgetStdout, Buffer.alloc(0)],
								stdout: budgetStdout,
								stderr: Buffer.alloc(0),
								status: null,
								signal: 'SIGTERM',
								error: new Error('ETIMEDOUT'),
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'token-budget',
						() =>
							({
								pid: 1,
								output: [null, tokenBudgetStdout, Buffer.alloc(0)],
								stdout: tokenBudgetStdout,
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'unsafe-token-sum',
						() =>
							({
								pid: 1,
								output: [null, unsafeTokenSumStdout, Buffer.alloc(0)],
								stdout: unsafeTokenSumStdout,
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'invalid-suffix-after-budget-prefix',
						() =>
							({
								pid: 1,
								output: [null, overbudgetPrefixWithInvalidSuffix, Buffer.alloc(0)],
								stdout: overbudgetPrefixWithInvalidSuffix,
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'timeout',
						() =>
							({
								pid: 1,
								output: [null, validFailureStdout, Buffer.alloc(0)],
								stdout: validFailureStdout,
								stderr: Buffer.alloc(0),
								status: null,
								signal: 'SIGTERM',
								error: new Error('ETIMEDOUT'),
							}) as ReturnType<CellSpawner>,
						false,
					],
					[
						'secret',
						() =>
							({
								pid: 1,
								output: [
									null,
									Buffer.from('sk-1234567890abcdef\n'),
									Buffer.alloc(0),
								],
								stdout: Buffer.from('sk-1234567890abcdef\n'),
								stderr: Buffer.alloc(0),
								status: 1,
								signal: null,
							}) as ReturnType<CellSpawner>,
						true,
					],
				];
				for (const [name, resultFactory, fatal] of failureCases) {
					let failureCalls = 0;
					const failureStage = join(temp, `failure-${name}-stage`);
					const failureFinal = join(temp, `failure-${name}-final`);
					const failureSpawner = (() => {
						failureCalls += 1;
						return resultFactory();
					}) as CellSpawner;
					let fatalRejected = false;
					let sealedFailureRuns: RunRecord[] | undefined;
					try {
						const failureRuns = productionPipeline({
							stage: failureStage,
							final: failureFinal,
							authority,
							includeEvidenceCalibration: false,
							spawner: failureSpawner,
						});
						sealedFailureRuns = failureRuns;
						if (
							fatal ||
							failureRuns[0]?.state !== 'failed' ||
							failureRuns.slice(1).some((run) => run.state !== 'unrun')
						)
							throw new Error(`${name} failure was not durably sealed`);
					} catch (error) {
						if (!fatal) throw error;
						fatalRejected = true;
					}
					if (
						failureCalls !== 1 ||
						(fatal && (!fatalRejected || existsSync(failureFinal)))
					)
						throw new Error(`${name} failure call/fatal contract mismatch`);
					if (name === 'throw' && sealedFailureRuns !== undefined) {
						const thrownRun = sealedFailureRuns[0];
						const thrownInspection = inspectCodexTranscript(
							readFileSync(
								join(failureFinal, 'raw', `${thrownRun?.id}.stdout.jsonl`),
							),
						);
						const thrownScores = JSON.parse(
							readFileSync(join(failureFinal, 'scores.json'), 'utf8'),
						) as ScoresFile;
						const expectedMarkers = [
							'TRANSPORT: sentinel spawn throw',
							'NO_RESULT: spawn returned no result',
							'PROCESS_STATUS: -1',
							'TRANSCRIPT: Codex terminal agent message missing',
						];
						if (
							thrownRun?.state !== 'failed' ||
							thrownRun.status !== -1 ||
							thrownRun.signal !== null ||
							thrownRun.timedOut ||
							thrownRun.failureReason !== expectedMarkers.join(' | ') ||
							stableJson(thrownRun.spawnProvenance) !==
								stableJson({
									attempted: true,
									returned: false,
									thrownMessage: 'sentinel spawn throw',
									resultErrorMessage: null,
								}) ||
							thrownRun.toolCalls !== 0 ||
							thrownRun.reportedTotalTokens !== 0 ||
							thrownRun.guesslessInvocations !== 0 ||
							thrownRun.terminal !== undefined ||
							thrownInspection.error !== 'Codex terminal agent message missing' ||
							readFileSync(join(failureFinal, 'raw', `${thrownRun.id}.stdout.jsonl`))
								.length !== 0 ||
							readFileSync(join(failureFinal, 'raw', `${thrownRun.id}.stderr.txt`))
								.length !== 0 ||
							stableJson(parseRuns(failureFinal)) !== stableJson(sealedFailureRuns) ||
							sealedFailureRuns.slice(1).some((run) => run.state !== 'unrun') ||
							thrownScores.cells.length !== 0 ||
							stableJson(thrownScores.pairedTotals) !== stableJson(aggregate([]))
						)
							throw new Error('thrown-spawner/no-result partial contract mismatch');
					}
					if (sealedFailureRuns?.[0]?.state === 'failed') {
						for (const [reasonIndex, reason] of sealedFailureRuns[0].failureReason
							.split(' | ')
							.entries())
							expectRunMutationRejected(
								failureFinal,
								`failure-${name}-reason-${reasonIndex}`,
								(records) => {
									records[0].failureReason = records[0].failureReason
										.split(' | ')
										.filter((candidate: string) => candidate !== reason)
										.join(' | ');
								},
							);
						expectRunMutationRejected(
							failureFinal,
							`failure-${name}-substituted-reason`,
							(records) => {
								records[0].failureReason = 'PROCESS_STATUS: 0';
							},
						);
						if (name === 'throw')
							expectSynchronizedBundleRejected(
								failureFinal,
								'all-unrun-synchronized',
								(copy, records) => {
									records.splice(
										0,
										records.length,
										...ORDER.map((cell) => canonicalUnrunRecord(cell)),
									);
									for (const cell of ORDER) {
										writeFileSync(
											join(copy, 'raw', `${cell.id}.stdout.jsonl`),
											Buffer.alloc(0),
										);
										writeFileSync(
											join(copy, 'raw', `${cell.id}.stderr.txt`),
											Buffer.alloc(0),
										);
									}
									return [];
								},
								'evaluation run topology mismatch',
							);
						if (name === 'timeout')
							expectSynchronizedBundleRejected(
								failureFinal,
								'completed-prefix-unrun-suffix-synchronized',
								(_copy, records) => {
									const completed = records[0];
									completed.state = 'completed';
									completed.status = 0;
									completed.signal = null;
									completed.timedOut = false;
									completed.spawnProvenance = {
										attempted: true,
										returned: true,
										thrownMessage: null,
										resultErrorMessage: null,
									};
									completed.immutablePostflight = false;
									delete completed.failureReason;
									return [
										scoreCell(
											completed.task,
											completed.arm,
											completed.terminal,
											authority.truth,
										),
									];
								},
								'evaluation run topology mismatch',
							);
						if (name === 'nonzero-budget')
							expectRunMutationRejected(
								failureFinal,
								'failed-nonboolean-immutable-postflight',
								(records) => {
									records[0].immutablePostflight = 'false';
								},
								`${sealedFailureRuns[0].id} immutablePostflight boolean mismatch`,
							);
					}
				}
				const guardParent = join(temp, 'prior-attempt-parent');
				mkdirSync(guardParent);
				const finalName = evidenceId === EVIDENCE_ID ? 'oracle-part-3' : 'oracle-part-3-v2';
				const guardedFinal = join(guardParent, finalName);
				const preservedStage = join(guardParent, `.staging-${evidenceId}-simulated`);
				let fatalSpawnCalls = 0;
				const fatalSpawner = (() => {
					fatalSpawnCalls += 1;
					return {
						pid: 1,
						output: [null, Buffer.from('sk-1234567890abcdef\n'), Buffer.alloc(0)],
						stdout: Buffer.from('sk-1234567890abcdef\n'),
						stderr: Buffer.alloc(0),
						status: 1,
						signal: null,
					} as ReturnType<CellSpawner>;
				}) as CellSpawner;
				let fatalStagePreserved = false;
				try {
					productionPipeline({
						stage: preservedStage,
						final: guardedFinal,
						authority,
						includeEvidenceCalibration: false,
						spawner: fatalSpawner,
					});
				} catch {
					fatalStagePreserved =
						existsSync(preservedStage) &&
						!existsSync(guardedFinal) &&
						readdirSync(join(preservedStage, 'raw')).length === 0;
				}
				let retryGuardRejected = false;
				let retrySpawnerCalls = 0;
				try {
					assertNoPriorEvaluationAttempt(guardedFinal, evidenceId);
					retrySpawnerCalls += 1;
				} catch {
					retryGuardRejected = true;
				}
				if (
					fatalSpawnCalls !== 1 ||
					!fatalStagePreserved ||
					!retryGuardRejected ||
					retrySpawnerCalls !== 0
				)
					throw new Error('post-spawn fatal staging did not block retry before spawn');
				const priorEntryCases = [
					{
						name: 'final-symlink',
						entryName: finalName,
						create(entryPath: string): void {
							symlinkSync(authority.fixtureRoot, entryPath);
						},
					},
					{
						name: 'staging-symlink',
						entryName: `.staging-${evidenceId}-symlink`,
						create(entryPath: string): void {
							symlinkSync(authority.fixtureRoot, entryPath);
						},
					},
					{
						name: 'staging-special-entry',
						entryName: `.staging-${evidenceId}-special`,
						create(entryPath: string): void {
							writeFileSync(entryPath, 'sentinel', { mode: 0o600 });
						},
					},
				] as const;
				for (const priorEntryCase of priorEntryCases) {
					const priorEntryParent = join(temp, `prior-entry-${priorEntryCase.name}`);
					mkdirSync(priorEntryParent);
					priorEntryCase.create(join(priorEntryParent, priorEntryCase.entryName));
					let priorEntryRejected = false;
					try {
						assertNoPriorEvaluationAttempt(
							join(priorEntryParent, finalName),
							evidenceId,
						);
					} catch {
						priorEntryRejected = true;
					}
					if (!priorEntryRejected)
						throw new Error(`prior-attempt guard accepted ${priorEntryCase.name}`);
				}
				const runnerMutations: readonly [
					string,
					(argv: string[], options: { env?: NodeJS.ProcessEnv }, call: number) => void,
				][] = [
					['argv-extra', (argv) => argv.splice(-1, 0, '--unexpected')],
					['argv-missing', (argv) => argv.splice(argv.indexOf('--json'), 1)],
					[
						'argv-reordered',
						(argv) => {
							const sandbox = argv.indexOf('--sandbox');
							[argv[sandbox], argv[sandbox + 1]] = [
								argv[sandbox + 1]!,
								argv[sandbox]!,
							];
						},
					],
					[
						'control-arm-leakage',
						(argv) =>
							argv.splice(
								-1,
								0,
								'-c',
								`mcp_servers.guessless.command=${JSON.stringify(authority.mcpCommand)}`,
								'-c',
								`mcp_servers.guessless.args=[${JSON.stringify(authority.mcpServer)}]`,
							),
					],
					[
						'mcp-value',
						(argv, _options, call) => {
							if (call === 1) {
								const index = argv.findIndex((value) =>
									value.startsWith('mcp_servers.guessless.command='),
								);
								argv[index] = 'mcp_servers.guessless.command="relative-node"';
							}
						},
					],
					[
						'env-fixed',
						(_argv, options) => {
							if (options.env) options.env.LANG = 'wrong';
						},
					],
					[
						'env-home',
						(_argv, options) => {
							if (options.env) options.env.HOME = '/wrong';
						},
					],
					[
						'env-temp',
						(_argv, options) => {
							if (options.env) options.env.TMPDIR = '/wrong';
						},
					],
					[
						'env-secret',
						(_argv, options) => {
							if (options.env) options.env.OPENAI_API_KEY = 'forbidden';
						},
					],
				];
				for (const [name, mutateRunner] of runnerMutations) {
					let runnerCalls = 0;
					const mutationSpawner = ((command, argv, options) => {
						mutateRunner((argv ?? []) as string[], options ?? {}, runnerCalls++);
						return spawner(command, argv, options);
					}) as CellSpawner;
					let rejected = false;
					try {
						productionPipeline({
							stage: join(temp, `runner-${name}-stage`),
							final: join(temp, `runner-${name}-final`),
							authority,
							includeEvidenceCalibration: false,
							spawner: mutationSpawner,
						});
					} catch {
						rejected = true;
					}
					if (!rejected || runnerCalls < 1)
						throw new Error(`${name} runner mutation was accepted or unexercised`);
				}
			}
			if (failedAt === 2)
				expectSynchronizedBundleRejected(
					join(temp, 'final'),
					'multiple-failures-synchronized',
					(_copy, records) => {
						records[0].state = 'failed';
						records[0].status = 1;
						records[0].failureReason = 'PROCESS_STATUS: 1';
						const completed = records[1];
						return [
							scoreCell(
								completed.task,
								completed.arm,
								completed.terminal,
								authority.truth,
							),
						];
					},
					'evaluation run topology mismatch',
				);
			records.push({
				guard:
					failedAt === null
						? 'production-complete-zero-codex'
						: `production-failure-${failedAt}`,
				expectedRed: true,
				restorationByteIdentical:
					stableJson(original) === stableJson(loadProtocol(fixtureRoot)),
				evidence:
					failedAt === null
						? 'six completed sentinel cells'
						: `durable failure at ${failedAt}`,
			});
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	};
	for (const failedAt of [null, 0, 2, 5] as const) calibrateSequence(failedAt);
	const failedRecords = records.filter(
		(record) => !record.expectedRed || !record.restorationByteIdentical,
	);
	if (failedRecords.length > 0)
		throw new Error(
			`fixture calibration failed: ${failedRecords
				.map(
					(record) =>
						`${record.guard}[expectedRed=${record.expectedRed},restorationByteIdentical=${record.restorationByteIdentical}]`,
				)
				.join(', ')}`,
		);
	return records;
}

function v3FixtureCalibrations(): CalibrationRecord[] {
	const fixtureRoot = paths(undefined, V3_EVIDENCE_ID).fixtureRoot;
	const v2Root = paths(undefined, V2_EVIDENCE_ID).fixtureRoot;
	proveGroundTruth(fixtureRoot);
	const protocol = loadProtocol(fixtureRoot);
	for (const relative of [
		'ground-truth.json',
		'response.schema.json',
		...protocol.inputFiles.map((file) => `input/${file.path}`),
	])
		if (!readFileSync(join(fixtureRoot, relative)).equals(readFileSync(join(v2Root, relative))))
			throw new Error(`v3 parity mismatch: ${relative}`);
	const records: CalibrationRecord[] = [];
	const red = (guard: string, action: () => void): void => {
		const before = stableJson(fileLedger(fixtureRoot));
		let evidence = '';
		try {
			action();
		} catch (error) {
			evidence = error instanceof Error ? error.message : String(error);
		}
		records.push({
			guard,
			expectedRed: evidence.length > 0,
			restorationByteIdentical: before === stableJson(fileLedger(fixtureRoot)),
			evidence,
		});
	};
	for (const [guard, mutate] of [
		['v3-order', (value: any) => value.order.reverse()],
		['v3-identity', (value: any) => (value.evidenceId = V2_EVIDENCE_ID)],
		['v3-tool-budget', (value: any) => (value.budgets.maxToolCalls = 17)],
		['v3-token-gate', (value: any) => (value.budgets.maxReportedTotalTokens = 16_000)],
		['v3-decision', (value: any) => (value.scoring.decision = 'subjective')],
	] as const)
		red(guard, () => {
			const temp = mkdtempSync(join(realpathSync(tmpdir()), 'guessless-v3-protocol-'));
			try {
				cpSync(fixtureRoot, temp, { recursive: true });
				const path = join(temp, 'protocol.json');
				const value = JSON.parse(readFileSync(path, 'utf8'));
				mutate(value);
				writeFileSync(path, stableJson(value));
				loadProtocol(temp);
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		});
	red('v3-statistics', () => {
		const sign = exactSignTest([1, 1, 1, 1, 1, 0]);
		if (sign.treatmentP !== 0.03125 || sign.twoSidedP !== 0.0625)
			throw new Error('exact sign-test sentinel mismatch');
		const interval = exactMedianSummary(Array.from({ length: 18 }, (_, index) => index + 1));
		if (stableJson(interval.interval95) !== stableJson([5, 14]))
			throw new Error('exact median interval sentinel mismatch');
		throw new Error('statistics mutation sentinel rejected');
	});
	const temp = mkdtempSync(join(realpathSync(tmpdir()), 'guessless-v3-continuation-'));
	try {
		const stage = join(temp, 'stage');
		mkdirSync(join(stage, 'raw'), { recursive: true });
		mkdirSync(join(stage, '.preflight/input'), { recursive: true });
		cpSync(join(fixtureRoot, 'input'), join(stage, '.preflight/input'), { recursive: true });
		cpSync(join(fixtureRoot, 'protocol.json'), join(stage, '.preflight/protocol.json'));
		cpSync(
			join(fixtureRoot, 'response.schema.json'),
			join(stage, '.preflight/response.schema.json'),
		);
		writeFileSync(join(stage, '.preflight/manifest.json'), preflightLedger(stage));
		let calls = 0;
		const truth = loadGroundTruth(fixtureRoot);
		const runs = executeRunSequence(
			stage,
			(task, arm) => {
				const index = calls++;
				const terminal = {
					status:
						truth[task].unresolved.length === 0
							? ('complete' as const)
							: ('partial' as const),
					reportedSiteIds: truth[task].planted,
					unresolvedSiteIds: truth[task].unresolved,
					reasoning: 'v3 calibration',
				};
				const stdout = Buffer.from(
					jsonLines([
						...(arm === 'guessless'
							? [
									{
										type: 'item.started',
										item: { type: 'mcp_tool_call', server: 'guessless' },
									},
								]
							: []),
						{
							type: 'item.completed',
							item: { type: 'agent_message', text: JSON.stringify(terminal) },
						},
						{
							type: 'turn.completed',
							usage: { input_tokens: 61_066, output_tokens: 1 },
						},
					]),
				);
				return {
					argv: ['codex'],
					environmentNames: [],
					environmentValueFingerprints: {},
					status: index === 0 ? 1 : 0,
					signal: null,
					timedOut: false,
					durationMs: 10,
					stdout,
					stderr: Buffer.alloc(0),
					stdoutSha256: sha256(stdout),
					stderrSha256: sha256(Buffer.alloc(0)),
					toolCalls: 1,
					reportedTotalTokens: 61_067,
					guesslessInvocations: arm === 'guessless' ? 1 : 0,
					spawnProvenance: {
						attempted: true,
						returned: true,
						thrownMessage: null,
						resultErrorMessage: null,
					},
					terminal,
					...(index === 0 ? { failureReason: 'PROCESS_STATUS: 1' } : {}),
				};
			},
			V3_ORDER,
			true,
		);
		if (
			calls !== 36 ||
			runs[0]?.state !== 'failed' ||
			runs.slice(1).some((run) => run.state !== 'completed')
		)
			throw new Error('v3 continuation topology mismatch');
		records.push({
			guard: 'v3-continuation-record-only-tokens',
			expectedRed: true,
			restorationByteIdentical: true,
			evidence:
				'36 calls continued after local invalidity; 61067 tokens recorded without gating',
		});
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	for (const [fatalAt, localAt, sameCellLocalFatal] of [
		[0, null, false],
		[17, 2, false],
		[35, 2, false],
		[17, 17, true],
	] as const) {
		const fatalTemp = mkdtempSync(join(realpathSync(tmpdir()), 'guessless-v3-fatal-'));
		try {
			const stage = join(fatalTemp, 'stage');
			mkdirSync(join(stage, 'raw'), { recursive: true });
			mkdirSync(join(stage, '.preflight/input'), { recursive: true });
			cpSync(join(fixtureRoot, 'input'), join(stage, '.preflight/input'), {
				recursive: true,
			});
			cpSync(join(fixtureRoot, 'protocol.json'), join(stage, '.preflight/protocol.json'));
			cpSync(
				join(fixtureRoot, 'response.schema.json'),
				join(stage, '.preflight/response.schema.json'),
			);
			writeFileSync(join(stage, '.preflight/manifest.json'), preflightLedger(stage));
			let calls = 0;
			const truth = loadGroundTruth(fixtureRoot);
			const runs = executeRunSequence(
				stage,
				(task, arm) => {
					const index = calls++;
					if (index === fatalAt && !sameCellLocalFatal)
						throw new FatalEvaluationError('runner stream contains a secret pattern');
					const terminal = {
						status:
							truth[task].unresolved.length === 0
								? ('complete' as const)
								: ('partial' as const),
						reportedSiteIds: truth[task].planted,
						unresolvedSiteIds: truth[task].unresolved,
						reasoning: 'v3 fatal calibration',
					};
					const stdout = Buffer.from(
						jsonLines([
							...(arm === 'guessless'
								? [
										{
											type: 'item.started',
											item: { type: 'mcp_tool_call', server: 'guessless' },
										},
									]
								: []),
							{
								type: 'item.completed',
								item: { type: 'agent_message', text: JSON.stringify(terminal) },
							},
							{
								type: 'turn.completed',
								usage: { input_tokens: 10, output_tokens: 5 },
							},
						]),
					);
					if (index === fatalAt && sameCellLocalFatal)
						writeFileSync(join(stage, '.preflight/protocol.json'), 'mutated');
					return {
						argv: ['codex'],
						environmentNames: [],
						environmentValueFingerprints: {},
						status: index === localAt ? 1 : 0,
						signal: null,
						timedOut: false,
						durationMs: 10,
						stdout,
						stderr: Buffer.alloc(0),
						stdoutSha256: sha256(stdout),
						stderrSha256: sha256(Buffer.alloc(0)),
						toolCalls: 1,
						reportedTotalTokens: 15,
						guesslessInvocations: arm === 'guessless' ? 1 : 0,
						spawnProvenance: {
							attempted: true,
							returned: true,
							thrownMessage: null,
							resultErrorMessage: null,
						},
						terminal,
						...(index === localAt ? { failureReason: 'PROCESS_STATUS: 1' } : {}),
					};
				},
				V3_ORDER,
				true,
			);
			const analysis = v3AnalysisFor(runs, truth);
			if (
				calls !== fatalAt + 1 ||
				runs[fatalAt]?.state !== 'failed' ||
				!hasRunFatalComponent(runs[fatalAt]?.failureReason) ||
				runs.slice(fatalAt + 1).some((run) => run.state !== 'unrun') ||
				(localAt !== null && runs[localAt]?.state !== 'failed') ||
				(sameCellLocalFatal &&
					!runs[fatalAt]?.failureReason.includes(
						'PROCESS_STATUS: 1 | RUN_FATAL: IMMUTABLE_PREFLIGHT',
					)) ||
				analysis.decision !== 'INCONCLUSIVE' ||
				analysis.runFatal !== true
			)
				throw new Error(`v3 fatal topology mismatch at ${fatalAt}`);
			records.push({
				guard: `v3-fatal-${fatalAt}${
					sameCellLocalFatal
						? '-same-cell-local-plus-fatal'
						: localAt === null
							? ''
							: '-after-local-invalidity'
				}`,
				expectedRed: true,
				restorationByteIdentical: true,
				evidence: `fatal cell ${fatalAt} forced INCONCLUSIVE and canonical unrun suffix`,
			});
		} finally {
			rmSync(fatalTemp, { recursive: true, force: true });
		}
	}
	const truth = loadGroundTruth(fixtureRoot);
	for (const task of ['delete', 'reach'] as const) {
		const response = {
			status: 'complete' as const,
			reportedSiteIds: truth[task].planted,
			unresolvedSiteIds: truth[task].unresolved,
			reasoning: 'false-completeness calibration',
		};
		if (!isV3FalseComplete(response, truth[task]))
			throw new Error(
				`${task} complete truth-unresolved response escaped false-completeness`,
			);
	}
	records.push({
		guard: 'v3-truth-unresolved-false-completeness',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence:
			'complete delete/reach responses are false-complete even when unresolved IDs are named',
	});
	const tiedCounterexample: PairMetricInput[] = (['rename', 'delete', 'reach'] as const).flatMap(
		(task) =>
			Array.from({ length: 6 }, (_, index) => ({
				task,
				controlCorrect: task !== 'reach' || index < 4,
				treatmentCorrect: task !== 'reach' || index < 4,
				controlFalseCompleteness: false,
				treatmentFalseCompleteness: false,
				durationRatio: 0.5,
				tokenRatio: 1,
				toolCallDelta: 0,
			})),
	);
	const tiedDecision = analyzePairs(
		tiedCounterexample,
		{ rename: 6, delete: 6, reach: 6 },
		false,
	);
	if (
		tiedDecision.decision !== 'PILOT' ||
		stableJson(tiedDecision.bothCorrectPairsByTask) !==
			stableJson({ rename: 6, delete: 6, reach: 4 })
	)
		throw new Error('tied ADOPT per-task both-correct threshold mismatch');
	records.push({
		guard: 'v3-tied-adopt-both-correct-per-task',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence: '16 both-correct overall with only four reach pairs mechanically yields PILOT',
	});
	if (records.some((record) => !record.expectedRed || !record.restorationByteIdentical))
		throw new Error('v3 fixture calibration failed');
	return records;
}

function offlineMcpSmoke(root: string): string {
	const server = realpathSync(join(root, 'packages/mcp/dist/server.js'));
	const input = jsonLines([
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'guessless-offline-calibration', version: '1' },
			},
		},
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
	]);
	const result = spawnSync(realpathSync(process.execPath), [server], {
		input,
		encoding: 'utf8',
		timeout: 10_000,
		env: buildChildEnvironment(),
	});
	if (result.status !== 0 || result.signal !== null || result.error !== undefined)
		throw new Error('offline MCP smoke process failed');
	const responses = String(result.stdout)
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const initialized = responses.find((response) => response.id === 1);
	const listed = responses.find((response) => response.id === 2);
	const tools = listed?.result?.tools;
	if (
		initialized?.result?.serverInfo?.name !== '@guessless/mcp' ||
		!Array.isArray(tools) ||
		tools.length < 1 ||
		!tools.every(
			(tool: unknown) =>
				typeof (tool as { name?: unknown }).name === 'string' &&
				String((tool as { name: string }).name).startsWith('guessless_'),
		)
	)
		throw new Error('offline MCP initialize/tools-list contract mismatch');
	return `${tools.length} usable Guessless tools`;
}

function v4FixtureCalibrations(): CalibrationRecord[] {
	const fixtureRoot = paths(undefined, V4_EVIDENCE_ID).fixtureRoot;
	const v3Root = paths(undefined, V3_EVIDENCE_ID).fixtureRoot;
	const protocol = loadProtocol(fixtureRoot);
	const truth = loadGroundTruth(fixtureRoot);
	const records = v3FixtureCalibrations().map((record) => ({
		...record,
		guard: `inherited-${record.guard}`,
	}));
	for (const relative of [
		'ground-truth.json',
		'response.schema.json',
		...protocol.inputFiles.map((file) => `input/${file.path}`),
	])
		if (!readFileSync(join(fixtureRoot, relative)).equals(readFileSync(join(v3Root, relative))))
			throw new Error(`v4 parity mismatch: ${relative}`);
	const expectedExposure =
		'If the Guessless MCP server is available, you MUST invoke at least one Guessless tool before any command execution; if it is unavailable, proceed with the available read-only tools.';
	if (
		!protocol.systemInstruction.endsWith(` ${expectedExposure}`) ||
		protocol.order !== protocol.order ||
		stableJson(protocol.order) !== stableJson(V4_ORDER)
	)
		throw new Error('v4 shared exposure/order contract mismatch');
	const terminal = (reasoning: string) => ({
		status: 'complete' as const,
		reportedSiteIds: truth.rename.planted,
		unresolvedSiteIds: truth.rename.unresolved,
		reasoning,
	});
	const transcript = (
		messages: readonly unknown[],
		turnPositions: readonly number[] = [messages.length],
	): Buffer => {
		const events = messages.map((message) => ({
			type: 'item.completed',
			item: {
				type: 'agent_message',
				text: typeof message === 'string' ? message : JSON.stringify(message),
			},
		}));
		for (const [offset, position] of turnPositions.entries())
			events.splice(position + offset, 0, {
				type: 'turn.completed',
				usage: { input_tokens: 10, output_tokens: 5 },
			} as never);
		return Buffer.from(jsonLines(events));
	};
	for (const count of [1, 2, 4]) {
		const messages = Array.from({ length: count }, (_, index) => terminal(`message-${index}`));
		const replayed = replayCodexTranscript(transcript(messages), 'v4');
		if (
			replayed.terminal.reasoning !== `message-${count - 1}` ||
			replayed.reportedTotalTokens !== 15
		)
			throw new Error(`v4 ${count}-message terminal selection mismatch`);
		records.push({
			guard: `v4-terminal-valid-${count}`,
			expectedRed: true,
			restorationByteIdentical: true,
			evidence: `selected last of ${count} schema-valid messages with one later turn`,
		});
	}
	for (const [guard, bytes] of [
		['zero-message', transcript([], [0])],
		['malformed-message', transcript([terminal('valid'), '{bad'])],
		['turn-before-terminal', transcript([terminal('late')], [0])],
		['multiple-turns', transcript([terminal('valid')], [1, 1])],
		['trailing-terminal', transcript([terminal('before'), terminal('after')], [1])],
	] as const) {
		let rejected = false;
		try {
			replayCodexTranscript(bytes, 'v4');
		} catch {
			rejected = true;
		}
		if (!rejected) throw new Error(`v4 ${guard} transcript was accepted`);
		records.push({
			guard: `v4-terminal-red-${guard}`,
			expectedRed: true,
			restorationByteIdentical: true,
			evidence: 'invalid terminal/turn topology rejected',
		});
	}
	const config = paths(undefined, V4_EVIDENCE_ID);
	const authority = freezeAuthority(fixtureRoot, '/canonical/codex', config.root);
	let calls = 0;
	const spawner = ((_command: string, argv: readonly string[]) => {
		const index = calls++;
		const prompt = argv?.at(-1);
		const task = (Object.keys(protocol.tasks) as (keyof typeof TASKS)[]).find(
			(candidate) => protocol.tasks[candidate] === prompt,
		)!;
		const treatment = argv?.some((value) => value.includes('mcp_servers.guessless.command='));
		const response = {
			status: truth[task].unresolved.length === 0 ? 'complete' : 'partial',
			reportedSiteIds: truth[task].planted,
			unresolvedSiteIds: truth[task].unresolved,
			reasoning: `final-${index}`,
		};
		const stdout = Buffer.from(
			jsonLines([
				...(treatment
					? [
							{
								type: 'item.started',
								item: { type: 'mcp_tool_call', server: 'guessless' },
							},
						]
					: []),
				{
					type: 'item.completed',
					item: {
						type: 'agent_message',
						text: JSON.stringify({ ...response, reasoning: 'draft' }),
					},
				},
				{
					type: 'item.completed',
					item: { type: 'agent_message', text: JSON.stringify(response) },
				},
				{ type: 'turn.completed', usage: { input_tokens: 61_066, output_tokens: 1 } },
			]),
		);
		return {
			pid: 50_000 + index,
			output: [null, stdout, Buffer.alloc(0)],
			stdout,
			stderr: Buffer.alloc(0),
			status: 0,
			signal: null,
		} as ReturnType<CellSpawner>;
	}) as CellSpawner;
	const temp = mkdtempSync(join(realpathSync(tmpdir()), 'guessless-v4-bundle-'));
	try {
		const final = join(temp, 'oracle-part-3-v4');
		const runs = productionPipeline({
			stage: join(temp, '.staging-oracle-part-3-v4-calibration'),
			final,
			authority,
			spawner,
			includeEvidenceCalibration: false,
		});
		if (calls !== 36 || runs.some((run) => run.state !== 'completed'))
			throw new Error('v4 complete 36-cell calibration mismatch');
		const manifest = JSON.parse(readFileSync(join(final, 'manifest.json'), 'utf8'));
		if (fileLedger(final).length !== 82 || manifest.files.length !== 81)
			throw new Error('v4 82-file topology mismatch');
		const mutations = evidenceCalibrations(final, false);
		if (mutations.some((record) => !record.expectedRed || !record.restorationByteIdentical))
			throw new Error('v4 evidence mutation calibration mismatch');
		records.push({
			guard: 'v4-complete-replay-manifest',
			expectedRed: true,
			restorationByteIdentical: true,
			evidence: `36 cells, 82 files, ${mutations.length} evidence mutations`,
		});
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	const smoke = offlineMcpSmoke(config.root);
	records.push({
		guard: 'v4-offline-mcp-initialize-tools-list',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence: smoke,
	});
	for (const [evidenceId, first] of [
		[EVIDENCE_ID, 'run-01-rename-control'],
		[V2_EVIDENCE_ID, 'run-01-rename-control'],
		[V3_EVIDENCE_ID, 'r01-rename-control'],
		[V4_EVIDENCE_ID, 'r01-rename-control'],
	] as const)
		if (loadProtocol(paths(undefined, evidenceId).fixtureRoot).order[0]?.id !== first)
			throw new Error(`${evidenceId} protocol-first-cell selection mismatch`);
	records.push({
		guard: 'v4-protocol-order-aware-first-cell',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence: 'v1/v2 select run-01; v3/v4 independently select r01',
	});
	const efficiencyPairs = (durationRatio: number, tokenRatio = 1, toolCallDelta = 0) =>
		(['rename', 'delete', 'reach'] as const).flatMap((task) =>
			Array.from({ length: 6 }, () => ({
				task,
				controlCorrect: true,
				treatmentCorrect: true,
				controlFalseCompleteness: false,
				treatmentFalseCompleteness: false,
				durationRatio,
				tokenRatio,
				toolCallDelta,
			})),
		);
	const decisionCases = [
		['ADOPT', efficiencyPairs(0.8)],
		['PILOT', efficiencyPairs(0.81)],
		['ADOPT', efficiencyPairs(0.5, 1.25)],
		['PILOT', efficiencyPairs(0.5, 1.26)],
		['DO_NOT_ADOPT', efficiencyPairs(1.5)],
		['PILOT', efficiencyPairs(1.49)],
		['DO_NOT_ADOPT', efficiencyPairs(1, 1, 3)],
		['PILOT', efficiencyPairs(1, 1, 2)],
	] as const;
	for (const [expected, pairs] of decisionCases) {
		const actual = analyzePairs(pairs, { rename: 6, delete: 6, reach: 6 }, false).decision;
		if (actual !== expected)
			throw new Error(
				`v4 decision boundary expected ${expected} but received ${String(actual)}`,
			);
	}
	if (
		analyzePairs(efficiencyPairs(0.5).slice(0, 15), { rename: 6, delete: 6, reach: 3 }, false)
			.decision !== 'INCONCLUSIVE'
	)
		throw new Error('v4 INCONCLUSIVE boundary mismatch');
	const correctnessPairs = (wins: number, losses: number): PairMetricInput[] =>
		efficiencyPairs(1).map((pair, index) => ({
			...pair,
			controlCorrect: index >= wins,
			treatmentCorrect: index < wins || index >= wins + losses,
		}));
	for (const [expected, wins, losses] of [
		['ADOPT', 5, 0],
		['PILOT', 4, 0],
		['DO_NOT_ADOPT', 0, 5],
		['PILOT', 0, 4],
	] as const) {
		const actual = analyzePairs(
			correctnessPairs(wins, losses),
			{ rename: 6, delete: 6, reach: 6 },
			false,
		).decision;
		if (actual !== expected)
			throw new Error(
				`v4 correctness boundary expected ${expected} but received ${String(actual)}`,
			);
	}
	records.push({
		guard: 'v4-decision-classes-boundaries',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence:
			'ADOPT/PILOT/DO_NOT_ADOPT/INCONCLUSIVE and numeric efficiency boundaries calibrated',
	});
	if (records.some((record) => !record.expectedRed || !record.restorationByteIdentical))
		throw new Error('v4 fixture calibration failed');
	return records;
}

function v5FixtureCalibrations(): CalibrationRecord[] {
	const fixtureRoot = paths(undefined, V5_EVIDENCE_ID).fixtureRoot;
	const v4Root = paths(undefined, V4_EVIDENCE_ID).fixtureRoot;
	const config = paths(undefined, V5_EVIDENCE_ID);
	const protocol = loadProtocol(fixtureRoot);
	const truth = proveGroundTruth(fixtureRoot) as ReturnType<typeof loadGroundTruth>;
	const records = v4FixtureCalibrations().map((record) => ({
		...record,
		guard: `inherited-${record.guard}`,
	}));
	for (const file of protocol.inputFiles)
		if (
			!readFileSync(join(fixtureRoot, 'input', file.path)).equals(
				readFileSync(join(v4Root, 'input', file.path)),
			)
		)
			throw new Error(`v5 input parity mismatch: ${file.path}`);
	records.push({
		guard: 'v5-independent-byte-lexeme-oracle',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence:
			'17 locked sites proven from source bytes, hashes, lines, columns, and first lexemes',
	});
	const valid = {
		status: 'partial' as const,
		reportedSiteIds: ['delete/state.ts:3:2'],
		unresolvedSiteIds: ['delete/dynamic.ts:3:55'],
		reasoning: 'contract calibration',
	};
	validateV5Response('delete', valid);
	for (const [guard, response] of [
		['unprefixed', { ...valid, reportedSiteIds: ['state.ts:3:2'] }],
		['cross-task-prefix', { ...valid, reportedSiteIds: ['rename/state.ts:3:2'] }],
		['overlap', { ...valid, unresolvedSiteIds: ['delete/state.ts:3:2'] }],
		['complete-with-unresolved', { ...valid, status: 'complete' }],
		['partial-without-unresolved', { ...valid, unresolvedSiteIds: [] }],
	] as const) {
		let evidence = '';
		try {
			validateV5Response('delete', response);
		} catch (error) {
			evidence = error instanceof Error ? error.message : String(error);
		}
		records.push({
			guard: `v5-response-${guard}`,
			expectedRed: evidence.length > 0,
			restorationByteIdentical: true,
			evidence,
		});
	}
	const mutateOracle = (
		guard: string,
		action: (rationale: any, recordedTruth: any) => void,
	): void => {
		const temp = mkdtempSync(join(realpathSync(tmpdir()), `guessless-v5-${guard}-`));
		let evidence = '';
		try {
			const copy = join(temp, V5_EVIDENCE_ID);
			cpSync(fixtureRoot, copy, { recursive: true });
			const rationalePath = join(copy, 'oracle-rationale.json');
			const truthPath = join(copy, 'ground-truth.json');
			const rationale = JSON.parse(readFileSync(rationalePath, 'utf8'));
			const recordedTruth = JSON.parse(readFileSync(truthPath, 'utf8'));
			action(rationale, recordedTruth);
			writeFileSync(rationalePath, stableJson(rationale));
			writeFileSync(truthPath, stableJson(recordedTruth));
			const mutatedProtocol = JSON.parse(readFileSync(join(copy, 'protocol.json'), 'utf8'));
			mutatedProtocol.oracleRationaleSha256 = sha256File(rationalePath);
			mutatedProtocol.groundTruthSha256 = sha256File(truthPath);
			writeFileSync(join(copy, 'protocol.json'), stableJson(mutatedProtocol));
			try {
				proveGroundTruth(copy);
			} catch (error) {
				evidence = error instanceof Error ? error.message : String(error);
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
		records.push({
			guard: `v5-oracle-${guard}`,
			expectedRed: evidence.length > 0,
			restorationByteIdentical: true,
			evidence,
		});
	};
	mutateOracle('coordinate', (rationale) => (rationale.sites[0].column += 1));
	mutateOracle('lexeme', (rationale) => (rationale.sites[0].lexeme = 'notTheLexeme'));
	mutateOracle('source-hash', (rationale) => (rationale.sites[0].sourceSha256 = '0'.repeat(64)));
	mutateOracle('field', (rationale) => (rationale.sites[0].field = 'unresolved'));
	mutateOracle('truth-overlap', (_rationale, recordedTruth) =>
		recordedTruth.delete.unresolved.push(recordedTruth.delete.resolved[0]),
	);

	let pathChecks = 0;
	const scratchSpawner = ((
		_command: string,
		argv: readonly string[],
		options: { cwd?: string },
	) => {
		const cwd = String(options.cwd);
		if (argv[argv.indexOf('-C') + 1] !== cwd) throw new Error('v5 Codex CWD mismatch');
		if (stableJson(readdirSync(cwd).sort()) !== stableJson(['rename']))
			throw new Error('v5 scratch root is not task-prefixed');
		if (!existsSync(join(cwd, 'rename', 'api.ts')))
			throw new Error('v5 task input missing below prefixed root');
		const treatment = argv.some((value) => value.includes('mcp_servers.guessless.command='));
		if (treatment && !argv.some((value) => value.includes(config.root)))
			throw new Error(
				'v5 Guessless server command is not shared from the scratch invocation',
			);
		pathChecks += 1;
		const response = {
			status: 'complete',
			reportedSiteIds: truth.rename.planted,
			unresolvedSiteIds: [],
			reasoning: 'scratch parity',
		};
		const stdout = Buffer.from(
			jsonLines([
				...(treatment
					? [
							{
								type: 'item.started',
								item: { type: 'mcp_tool_call', server: 'guessless' },
							},
						]
					: []),
				{
					type: 'item.completed',
					item: { type: 'agent_message', text: JSON.stringify(response) },
				},
				{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
			]),
		);
		return {
			pid: 55_000 + pathChecks,
			output: [null, stdout, Buffer.alloc(0)],
			stdout,
			stderr: Buffer.alloc(0),
			status: 0,
			signal: null,
		} as ReturnType<CellSpawner>;
	}) as CellSpawner;
	const cellConfig: CodexCellConfig = {
		executable: '/canonical/codex',
		protocol,
		responseSchemaPath: join(fixtureRoot, 'response.schema.json'),
		environment: buildChildEnvironment(),
		mcpCommand: realpathSync(process.execPath),
		mcpServer: realpathSync(join(config.root, 'packages/mcp/dist/server.js')),
		scratchParent: realpathSync(tmpdir()),
	};
	runCodexCell('rename', 'control', join(fixtureRoot, 'input'), cellConfig, scratchSpawner);
	runCodexCell('rename', 'guessless', join(fixtureRoot, 'input'), cellConfig, scratchSpawner);
	if (pathChecks !== 2) throw new Error('v5 both-arm scratch parity mismatch');
	records.push({
		guard: 'v5-task-prefixed-shared-root-both-arms',
		expectedRed: true,
		restorationByteIdentical: true,
		evidence: 'control and treatment both used scratch CWD with only rename/ at its root',
	});

	const authority = freezeAuthority(fixtureRoot, '/canonical/codex', config.root);
	let calls = 0;
	const spawner = ((_command: string, argv: readonly string[]) => {
		const index = calls++;
		const prompt = argv.at(-1);
		const task = (Object.keys(protocol.tasks) as (keyof typeof TASKS)[]).find(
			(candidate) => protocol.tasks[candidate] === prompt,
		)!;
		const treatment = argv.some((value) => value.includes('mcp_servers.guessless.command='));
		const response = {
			status: truth[task].unresolved.length === 0 ? 'complete' : 'partial',
			reportedSiteIds: truth[task].planted,
			unresolvedSiteIds: truth[task].unresolved,
			reasoning: `v5-final-${index}`,
		};
		const stdout = Buffer.from(
			jsonLines([
				...(treatment
					? [
							{
								type: 'item.started',
								item: { type: 'mcp_tool_call', server: 'guessless' },
							},
						]
					: []),
				{
					type: 'item.completed',
					item: { type: 'agent_message', text: JSON.stringify(response) },
				},
				{ type: 'turn.completed', usage: { input_tokens: 61_066, output_tokens: 1 } },
			]),
		);
		return {
			pid: 56_000 + index,
			output: [null, stdout, Buffer.alloc(0)],
			stdout,
			stderr: Buffer.alloc(0),
			status: 0,
			signal: null,
		} as ReturnType<CellSpawner>;
	}) as CellSpawner;
	const temp = mkdtempSync(join(realpathSync(tmpdir()), 'guessless-v5-bundle-'));
	try {
		const final = join(temp, V5_EVIDENCE_ID);
		const runs = productionPipeline({
			stage: join(temp, `.staging-${V5_EVIDENCE_ID}-calibration`),
			final,
			authority,
			spawner,
			includeEvidenceCalibration: false,
		});
		if (calls !== 36 || runs.some((run) => run.state !== 'completed'))
			throw new Error('v5 complete 36-cell calibration mismatch');
		const manifest = JSON.parse(readFileSync(join(final, 'manifest.json'), 'utf8'));
		if (fileLedger(final).length !== 82 || manifest.files.length !== 81)
			throw new Error('v5 82-file topology mismatch');
		const mutations = evidenceCalibrations(final, false);
		if (mutations.some((record) => !record.expectedRed || !record.restorationByteIdentical))
			throw new Error('v5 evidence mutation calibration mismatch');
		records.push({
			guard: 'v5-complete-replay-manifest',
			expectedRed: true,
			restorationByteIdentical: true,
			evidence: `36 cells, 82 files, ${mutations.length} evidence mutations`,
		});
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	if (records.some((record) => !record.expectedRed || !record.restorationByteIdentical))
		throw new Error('v5 fixture calibration failed');
	return records;
}

function evidenceCalibrations(
	root: string,
	includeFixtureCalibrations = true,
): CalibrationRecord[] {
	const evidenceId = evidenceIdAt(root);
	const protocolOrder = loadProtocol(paths(undefined, evidenceId).fixtureRoot).order;
	const records = includeFixtureCalibrations ? fixtureCalibrations(evidenceId) : [];
	const before = stableJson(manifestFor(root));
	const mutate = (guard: string, action: (copy: string) => void, stale = false): void => {
		const temp = mkdtempSync(
			join(realpathSync(tmpdir()), `structural-eval-evidence-${guard}-`),
		);
		let evidence = '';
		try {
			const copy = join(temp, evidenceId);
			cpSync(root, copy, { recursive: true });
			action(copy);
			if (!stale) reseal(copy);
			try {
				verifyRoot(copy);
			} catch (error) {
				evidence = error instanceof Error ? error.message : String(error);
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
		records.push({
			guard,
			expectedRed: evidence.length > 0,
			restorationByteIdentical: before === stableJson(manifestFor(root)),
			evidence,
		});
	};
	mutate('transcript', (copy) => {
		const path = join(copy, 'raw', `${protocolOrder[0]!.id}.stdout.jsonl`);
		writeFileSync(path, `${readFileSync(path, 'utf8')} `);
	});
	mutate('protocol-semantic', (copy) => {
		const path = join(copy, 'protocol.json');
		const value = JSON.parse(readFileSync(path, 'utf8'));
		value.scoring.aggregation = 'subjective';
		writeFileSync(path, stableJson(value));
	});
	const mutateRuns = (guard: string, action: (runs: any[]) => void): void =>
		mutate(guard, (copy) => {
			const path = join(copy, 'raw/runs.jsonl');
			const runs = readFileSync(path, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			action(runs);
			writeFileSync(path, jsonLines(runs));
		});
	mutateRuns('order', (runs) => {
		[runs[0], runs[1]] = [runs[1], runs[0]];
	});
	mutateRuns('failure-state', (runs) => {
		runs[0].state = 'failed';
		runs[0].failureReason = 'TRANSPORT: fabricated';
	});
	mutateRuns('unknown-state', (runs) => {
		runs[0].state = 'unknown';
	});
	mutateRuns('completed-forbidden-reason', (runs) => {
		const completedRun = runs.find((run) => run.state === 'completed');
		if (completedRun !== undefined) completedRun.failureReason = 'PROCESS_STATUS: 1';
		else runs[0].state = 'completed';
	});
	mutateRuns('completed-nonboolean-immutable-postflight', (runs) => {
		runs[0].immutablePostflight = 0;
	});
	mutateRuns('unrun-state', (runs) => {
		runs[0].state = 'unrun';
		runs[0].status = null;
	});
	mutateRuns('argv', (runs) => runs[0].argv.push('--unexpected'));
	mutateRuns('environment', (runs) => runs[0].environmentNames.push('EXTRA'));
	mutateRuns('tool-count', (runs) => (runs[0].toolCalls += 1));
	mutateRuns('token-count', (runs) => (runs[0].reportedTotalTokens += 1));
	mutateRuns('terminal', (runs) => {
		const terminalRun = runs.find((run) => run.terminal !== undefined);
		if (terminalRun !== undefined) terminalRun.terminal.reasoning = 'mutated';
		else
			runs[0].terminal = {
				status: 'complete',
				reportedSiteIds: [],
				unresolvedSiteIds: [],
				reasoning: 'fabricated calibration mutation',
			};
	});
	for (const field of ['reportedSiteIds', 'unresolvedSiteIds'] as const)
		mutate(`duplicate-${field}-transcript`, (copy) => {
			const runsPath = join(copy, 'raw/runs.jsonl');
			const runs = readFileSync(runsPath, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			const run = runs[0];
			const duplicate = 'rename/api.ts:1:1';
			const terminal: {
				status: 'partial';
				reportedSiteIds: string[];
				unresolvedSiteIds: string[];
				reasoning: string;
			} = {
				status: 'partial',
				reportedSiteIds: [],
				unresolvedSiteIds: [],
				reasoning: 'synchronized duplicate calibration mutation',
			};
			terminal[field] = [duplicate, duplicate];
			const stdoutPath = join(copy, 'raw', `${run.id}.stdout.jsonl`);
			const lines = readFileSync(stdoutPath, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const event = {
				type: 'item.completed',
				item: { type: 'agent_message', text: JSON.stringify(terminal) },
			};
			const index = lines.findIndex(
				(line) => line.type === 'item.completed' && line.item?.type === 'agent_message',
			);
			if (index < 0) lines.unshift(event);
			else lines[index] = event;
			const bytes = Buffer.from(jsonLines(lines));
			writeFileSync(stdoutPath, bytes);
			run.stdoutSha256 = sha256(bytes);
			run.terminal = terminal;
			writeFileSync(runsPath, jsonLines(runs));
		});
	mutate('score', (copy) => {
		const path = join(copy, 'scores.json');
		const value = JSON.parse(readFileSync(path, 'utf8'));
		if (value.cells.length === 0) value.cells.push({ fabricated: true });
		else value.cells[0].sitesMissed.push('rename/api.ts:1:1');
		writeFileSync(path, stableJson(value));
	});
	mutate('false-completeness', (copy) => {
		const path = join(copy, 'scores.json');
		const value = JSON.parse(readFileSync(path, 'utf8'));
		if (value.cells.length === 0) value.cells.push({ falseCompleteness: 1 });
		else value.cells[0].falseCompleteness = value.cells[0].falseCompleteness === 0 ? 1 : 0;
		writeFileSync(path, stableJson(value));
	});
	if (evidenceId !== EVIDENCE_ID) {
		for (const [guard, mutateBenchmarks] of [
			['benchmark-identity', (value: any) => (value.evidenceId = EVIDENCE_ID)],
			['benchmark-model', (value: any) => (value.model = 'wrong')],
			['benchmark-version', (value: any) => (value.codexVersion = 'wrong')],
			['benchmark-order', (value: any) => value.order.reverse()],
			['benchmark-fixture-task', (value: any) => (value.fixture.perTask.rename.files += 1)],
			['benchmark-fixture-total', (value: any) => (value.fixture.total.bytes += 1)],
			['benchmark-cell-identity', (value: any) => (value.cells[0].id = 'wrong')],
			['benchmark-cell-state', (value: any) => (value.cells[0].state = 'unrun')],
			['benchmark-cell-duration', (value: any) => (value.cells[0].durationMs += 1)],
			['benchmark-cell-tokens', (value: any) => (value.cells[0].reportedTotalTokens += 1)],
			['benchmark-cell-tools', (value: any) => (value.cells[0].toolCalls += 1)],
			[
				'benchmark-cell-guessless',
				(value: any) => (value.cells[0].guesslessInvocations += 1),
			],
			['benchmark-cell-status', (value: any) => (value.cells[0].status = 99)],
			['benchmark-limitations', (value: any) => value.limitations.pop()],
		] as const)
			mutate(guard, (copy) => {
				const path = join(copy, 'benchmarks.json');
				const value = JSON.parse(readFileSync(path, 'utf8'));
				mutateBenchmarks(value);
				writeFileSync(path, stableJson(value));
			});
	}
	if (isRepeatedEvidence(evidenceId)) {
		for (const [guard, file, mutateProjection] of [
			['decision-projection', 'decision.json', (value: any) => (value.decision = 'ADOPT')],
			['replay-projection', 'replay.json', (value: any) => (value.runCount += 1)],
		] as const)
			mutate(guard, (copy) => {
				const path = join(copy, file);
				const value = JSON.parse(readFileSync(path, 'utf8'));
				mutateProjection(value);
				writeFileSync(path, stableJson(value));
			});
	}
	mutate('partial-pair-totals', (copy) => {
		const path = join(copy, 'scores.json');
		const value = JSON.parse(readFileSync(path, 'utf8'));
		value.pairedTotals.control.sitesMissed += 1;
		writeFileSync(path, stableJson(value));
	});
	mutate(
		'manifest',
		(copy) => {
			const path = join(copy, 'summary.md');
			writeFileSync(path, `${readFileSync(path, 'utf8')}x`);
		},
		true,
	);
	const failedRecords = records.filter(
		(record) => !record.expectedRed || !record.restorationByteIdentical,
	);
	if (failedRecords.length > 0)
		throw new Error(
			`evidence calibration failed: ${failedRecords
				.map(
					(record) =>
						`${record.guard}[expectedRed=${record.expectedRed},restored=${record.restorationByteIdentical}]`,
				)
				.join(', ')}`,
		);
	return records;
}

function evidenceIdArgument(args: readonly string[]): EvidenceId {
	const value = args[args.indexOf('--evidence-id') + 1];
	if (
		[EVIDENCE_ID, V2_EVIDENCE_ID, V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(
			value as EvidenceId,
		)
	)
		return value as EvidenceId;
	const directory = args[args.indexOf('--evidence-dir') + 1];
	if (directory === 'docs/evidence/oracle-part-3') return EVIDENCE_ID;
	if (directory === 'docs/evidence/oracle-part-3-v2') return V2_EVIDENCE_ID;
	if (directory === 'docs/evidence/oracle-part-3-v3') return V3_EVIDENCE_ID;
	if (directory === 'docs/evidence/oracle-part-3-v4') return V4_EVIDENCE_ID;
	if (directory === 'docs/evidence/oracle-part-3-v5') return V5_EVIDENCE_ID;
	throw new Error('exact evaluation evidence identity required');
}

function exactEvidenceArgument(args: readonly string[]): string {
	const evidenceId = evidenceIdArgument(args);
	const argument = args[args.indexOf('--evidence-dir') + 1];
	const expected =
		evidenceId === EVIDENCE_ID ? 'docs/evidence/oracle-part-3' : `docs/evidence/${evidenceId}`;
	if (argument !== expected) throw new Error('exact evidence directory required');
	return paths(undefined, evidenceId).evidenceRoot;
}

export function calibrate(args: readonly string[]): void {
	if (args.includes('--fixture-only')) {
		if (process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT !== 'disabled')
			throw new Error('fixture calibration requires disabled consent');
		if (!args.includes('--offline')) throw new Error('fixture calibration identity mismatch');
		fixtureCalibrations(evidenceIdArgument(args));
		return;
	}
	if (process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT !== 'disabled')
		throw new Error('evidence calibration requires disabled consent');
	const root = exactEvidenceArgument(args);
	verifyRoot(root);
	const expected = readFileSync(join(root, 'raw/calibration.jsonl'), 'utf8');
	const actual = jsonLines(evidenceCalibrations(root));
	if (actual !== expected) throw new Error('evaluation calibration replay mismatch');
}

export function verify(args: readonly string[]): void {
	if (
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT !== 'disabled' ||
		!args.includes('--offline')
	)
		throw new Error('verification requires offline disabled consent');
	verifyRoot(exactEvidenceArgument(args));
}

function freezeAuthority(fixtureRoot: string, executable: string, root: string): FrozenAuthority {
	proveGroundTruth(fixtureRoot);
	const protocol = loadProtocol(fixtureRoot);
	const truth = loadGroundTruth(fixtureRoot);
	const inputRoot = join(fixtureRoot, 'input');
	const beforeLedger = fileLedger(fixtureRoot);
	const protocolBytes = readFileSync(join(fixtureRoot, 'protocol.json'));
	const responseSchemaBytes = readFileSync(join(fixtureRoot, 'response.schema.json'));
	const truthBytes = readFileSync(join(fixtureRoot, 'ground-truth.json'));
	const oracleRationaleBytes =
		protocol.evidenceId === V5_EVIDENCE_ID
			? readFileSync(join(fixtureRoot, 'oracle-rationale.json'))
			: undefined;
	const inputs = fileLedger(inputRoot).map((file) => ({
		path: file.path,
		bytes: readFileSync(join(inputRoot, file.path)),
	}));
	const environment = buildChildEnvironment();
	if (
		stableJson(JSON.parse(Buffer.from(protocolBytes).toString('utf8'))) !==
			stableJson(protocol) ||
		sha256(responseSchemaBytes) !== protocol.responseSchemaSha256 ||
		sha256(truthBytes) !== protocol.groundTruthSha256 ||
		(oracleRationaleBytes !== undefined &&
			sha256(oracleRationaleBytes) !== protocol.oracleRationaleSha256) ||
		stableJson(beforeLedger) !== stableJson(fileLedger(fixtureRoot)) ||
		inputs.some(
			(input) =>
				sha256(input.bytes) !==
				protocol.inputFiles.find((expected) => expected.path === input.path)?.sha256,
		)
	)
		throw new Error('authority source changed or disagreed during atomic capture');
	return {
		fixtureRoot,
		protocol,
		protocolBytes,
		responseSchemaBytes,
		truthBytes,
		...(oracleRationaleBytes === undefined ? {} : { oracleRationaleBytes }),
		truth,
		inputs,
		executable,
		mcpCommand: realpathSync(process.execPath),
		mcpServer: realpathSync(join(root, 'packages/mcp/dist/server.js')),
		environment,
		scratchParent: String(environment.TMPDIR),
	};
}

function productionPipeline(options: {
	readonly stage: string;
	readonly final: string;
	readonly authority: FrozenAuthority;
	readonly spawner: CellSpawner;
	readonly includeEvidenceCalibration: boolean;
	readonly postPromotionVerify?: (final: string) => void;
}): RunRecord[] {
	const { stage, final, authority } = options;
	if (existsSync(final)) throw new Error('evaluation evidence already exists');
	mkdirSync(stage);
	assertContained(dirname(final), stage);
	const raw = join(stage, 'raw');
	mkdirSync(raw);
	let invoked = false;
	try {
		const preflight = join(stage, '.preflight');
		mkdirSync(preflight);
		const stagedInput = join(preflight, 'input');
		mkdirSync(stagedInput);
		for (const input of authority.inputs) {
			const destination = join(stagedInput, input.path);
			mkdirSync(dirname(destination), { recursive: true });
			writeNew(destination, input.bytes);
		}
		writeNew(join(preflight, 'protocol.json'), authority.protocolBytes);
		writeNew(join(preflight, 'response.schema.json'), authority.responseSchemaBytes);
		if (authority.oracleRationaleBytes !== undefined)
			writeNew(join(preflight, 'oracle-rationale.json'), authority.oracleRationaleBytes);
		writeNew(join(preflight, 'manifest.json'), preflightLedger(stage));
		if (
			sha256File(join(preflight, 'protocol.json')) !== sha256(authority.protocolBytes) ||
			sha256File(join(preflight, 'response.schema.json')) !==
				sha256(authority.responseSchemaBytes) ||
			(authority.oracleRationaleBytes !== undefined &&
				sha256File(join(preflight, 'oracle-rationale.json')) !==
					sha256(authority.oracleRationaleBytes)) ||
			stableJson(fileLedger(stagedInput)) !== stableJson(authority.protocol.inputFiles)
		)
			throw new Error('staged authority snapshot mismatch');
		writeNew(join(stage, 'protocol.json'), authority.protocolBytes);
		const cellConfig: CodexCellConfig = {
			executable: authority.executable,
			protocol: authority.protocol,
			responseSchemaPath: join(preflight, 'response.schema.json'),
			environment: { ...authority.environment },
			mcpCommand: authority.mcpCommand,
			mcpServer: authority.mcpServer,
			scratchParent: authority.scratchParent,
		};
		const repeated = isRepeatedEvidence(authority.protocol.evidenceId);
		const runs = executeRunSequence(
			stage,
			(task, arm, inputRoot) => {
				invoked = true;
				return runCodexCell(task, arm, inputRoot, cellConfig, options.spawner);
			},
			authority.protocol.order,
			repeated,
		);
		const cells = runs
			.filter((run) => run.state === 'completed' && run.terminal !== undefined)
			.map((run) =>
				repeated
					? scoreV3Cell(run.task, run.arm, run.terminal!, authority.truth)
					: scoreCell(run.task, run.arm, run.terminal!, authority.truth),
			);
		writeNew(
			join(stage, 'commands.json'),
			stableJson({
				model: authority.protocol.model,
				codexVersion: authority.protocol.codexVersion,
				runs: runs.map((run) => ({
					id: run.id,
					argv: run.argv,
					environmentNames: run.environmentNames,
					environmentValueFingerprints: run.environmentValueFingerprints,
				})),
			}),
		);
		const pairedTotals = aggregate(
			repeated ? v3CompletePairScores(runs, authority.truth) : completePairs(cells),
		);
		const analysis = repeated ? v3AnalysisFor(runs, authority.truth) : undefined;
		writeNew(
			join(stage, 'scores.json'),
			stableJson({ cells, pairedTotals, ...(analysis === undefined ? {} : { analysis }) }),
		);
		writeNew(
			join(stage, 'summary.md'),
			[
				`# Guessless ${authority.protocol.evidenceId}`,
				'',
				repeated
					? `Thirty-six preregistered cells produced the mechanical decision ${String(analysis!.decision)}.`
					: runs.some((run) => run.state === 'failed')
						? 'Partial one-shot evaluation: exact failed-cell bytes and explicit unrun cells are preserved; no completed-pair claim is made.'
						: 'Six fresh one-shot paired Codex cells were mechanically scored across three narrowed synthetic structural-analysis tasks.',
				'',
				`Paired totals: \`${JSON.stringify(pairedTotals)}\`.`,
				'',
				repeated
					? 'Scope: repeated synthetic trials support only a reversible sibling-repository adoption decision.'
					: 'Limitation: this is one run per arm across three narrowed synthetic tasks; it does not establish general agent performance.',
				'',
			].join('\n'),
		);
		writeNew(join(raw, 'runs.jsonl'), jsonLines(runs));
		if (authority.protocol.evidenceId === V2_EVIDENCE_ID)
			writeNew(
				join(stage, 'benchmarks.json'),
				stableJson(benchmarksFor(authority.protocol, authority.truth, runs)),
			);
		if (repeated) {
			writeNew(
				join(stage, 'benchmarks.json'),
				stableJson(v3BenchmarksFor(authority.protocol, authority.truth, runs, analysis!)),
			);
			writeNew(
				join(stage, 'decision.json'),
				stableJson({
					schema: `guessless.evaluation-decision/${repeatedVersion(authority.protocol.evidenceId)}`,
					evidenceId: authority.protocol.evidenceId,
					decision: analysis!.decision,
					analysis,
					scope: 'reversible sibling-repository integration',
				}),
			);
			writeNew(
				join(stage, 'replay.json'),
				stableJson({
					schema: `guessless.evaluation-replay/${repeatedVersion(authority.protocol.evidenceId)}`,
					evidenceId: authority.protocol.evidenceId,
					runCount: runs.length,
					transcriptAggregateSha256: sha256(
						stableJson(
							runs.map((run) => ({
								id: run.id,
								stdoutSha256: run.stdoutSha256,
								stderrSha256: run.stderrSha256,
							})),
						),
					),
					analysis,
				}),
			);
		}
		rmSync(preflight, { recursive: true });
		writeNew(
			join(raw, 'calibration.jsonl'),
			jsonLines([
				{
					guard: 'pipeline',
					expectedRed: true,
					restorationByteIdentical: true,
					evidence: 'shared production pipeline sealed and replay-verified',
				},
			]),
		);
		writeNew(join(stage, 'manifest.json'), stableJson(manifestFor(stage)));
		if (options.includeEvidenceCalibration) {
			writeFileSync(join(raw, 'calibration.jsonl'), jsonLines(evidenceCalibrations(stage)));
			reseal(stage);
		}
		verifyRoot(stage, authority.protocol, authority.truth, authority);
		promoteNewWithRollback(stage, final, () => {
			verifyRoot(final, authority.protocol, authority.truth, authority);
			options.postPromotionVerify?.(final);
		});
		verifyRoot(final, authority.protocol, authority.truth, authority);
		return runs;
	} catch (error) {
		if (!invoked && existsSync(stage) && !lstatSync(stage).isSymbolicLink())
			rmSync(stage, { recursive: true });
		throw error;
	}
}

function assertNoPriorEvaluationAttempt(evidenceRoot: string, evidenceId: EvidenceId): void {
	const parent = assertRealDirectory(dirname(evidenceRoot), 'canonical evidence parent');
	const finalName = evidenceRoot.slice(parent.length + 1);
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (
			entry.name === finalName ||
			(entry.name.startsWith(`.staging-${evidenceId}-`) &&
				entry.name.length > `.staging-${evidenceId}-`.length)
		)
			throw new Error(`prior evaluation attempt exists: ${entry.name}`);
	}
}

export function record(args: readonly string[]): void {
	const evidenceId = evidenceIdArgument(args);
	if (
		process.env.GUESSLESS_EVALUATION_NETWORK_CONSENT !== evidenceId ||
		!args.includes('--allow-model-network') ||
		args[args.indexOf('--evidence-id') + 1] !== evidenceId
	)
		throw new Error('live evaluation consent/identity mismatch');
	if (
		args[args.indexOf('--model') + 1] !== MODEL ||
		args[args.indexOf('--codex-version') + 1] !== CODEX_VERSION
	)
		throw new Error('live evaluation model/version identity mismatch');
	const config = paths(undefined, evidenceId);
	assertCodexResponseSchemaCompatible(
		readFileSync(join(config.fixtureRoot, 'response.schema.json')),
	);
	assertNoPriorEvaluationAttempt(config.evidenceRoot, evidenceId);
	const executable = resolveCodexExecutable(String(process.env.PATH), (absolute) => {
		const result = spawnSync(absolute, ['--version'], { encoding: 'utf8' });
		if (result.status !== 0 || typeof result.stdout !== 'string')
			throw new Error('Codex version check failed');
		return result.stdout;
	});
	if (spawnSync(executable, ['login', 'status'], { encoding: 'utf8' }).status !== 0)
		throw new Error('Codex authentication unavailable');
	const authority = freezeAuthority(config.fixtureRoot, executable, config.root);
	const parent = realpathSync(dirname(config.evidenceRoot));
	const stageName = `.staging-${evidenceId}-${process.pid}`;
	const stage = join(parent, stageName);
	productionPipeline({
		stage,
		final: config.evidenceRoot,
		authority,
		spawner: spawnSync,
		includeEvidenceCalibration: true,
	});
}
