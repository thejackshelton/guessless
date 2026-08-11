import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const enginePackage: string = '@guessless/engine';
const { verifyReceipt, verifySafeChangeSummary } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');
import {
	V6_BUDGETS,
	V6_CODEX_EXECUTABLE_SHA256,
	V6_CODEX_VERSION,
	V6_ID,
	V6_MODEL,
	V6_NEUTRAL_SYSTEM_INSTRUCTION,
	V6_NODE_VERSION,
	V6_NODE_EXECUTABLE_SHA256,
	V6_PNPM_VERSION,
	V6_POLICY,
	V6_REPOSITORIES,
	V6_SCORING_GATES,
	V6_TASKS,
	sha256,
	stableJson,
	type V6Task,
} from './v6-contracts.ts';
import {
	computeRepositoryArtifacts,
	copyVerifiedArchives,
	evaluationPackageRoot,
	readCompressedJson,
	v6FixtureRoot,
	writeCompressedJson,
} from './v6-corpus.ts';
import { generateFakeV6Replay, verifyV6Replay, type V6SealedReplay } from './v6-codex.ts';

export type V6CellKind = 'consumption' | 'discovery';
export type V6CellArm = 'full' | 'summary' | 'control' | 'production';

export interface V6Cell {
	readonly id: string;
	readonly taskId: string;
	readonly kind: V6CellKind;
	readonly arm: V6CellArm;
	readonly ordinal: number;
}

function buildOrder(): V6Cell[] {
	const order: V6Cell[] = [];
	for (const [index, task] of V6_TASKS.entries()) {
		const consumption =
			index % 2 === 0 ? (['full', 'summary'] as const) : (['summary', 'full'] as const);
		const discovery =
			index % 2 === 0
				? (['control', 'production'] as const)
				: (['production', 'control'] as const);
		for (const arm of consumption)
			order.push({
				id: `v6-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'consumption',
				arm,
				ordinal: order.length + 1,
			});
		for (const arm of discovery)
			order.push({
				id: `v6-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'discovery',
				arm,
				ordinal: order.length + 1,
			});
	}
	return order;
}

function taskPrompt(task: V6Task): string {
	return `Assess the complete structural impact of the proposed ${task.intent} change to symbol '${task.symbol}' in '${task.file}'. Return every resolved canonical site with its ordered roles and every unresolved canonical site with its closed reason. Site IDs are deterministic source projections: use <path>:<one-based-line>:<one-based-UTF-8-byte-column>#resolved for resolved facts and <path>:<one-based-line>:<one-based-UTF-8-byte-column>#unresolved:<closed-reason> for unresolved facts. Use status complete only when no requested boundary remains unresolved; otherwise use partial or refused. Return exactly the supplied response schema.`;
}

function prompts(): Record<string, unknown> {
	return Object.fromEntries(
		V6_TASKS.map((task) => [
			task.id,
			{
				discovery: taskPrompt(task),
				consumption: {
					full: `${taskPrompt(task)} A full integrity-bound structural artifact is supplied as the initial local input.`,
					summary: `${taskPrompt(task)} A compact integrity-bound structural artifact is supplied as the initial local input. Full proof is available only by a separately counted on-demand local proof read keyed by proofHandle.`,
				},
			},
		]),
	);
}

const RESPONSE_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	additionalProperties: false,
	required: ['state', 'resolved', 'unresolved', 'reasoning'],
	properties: {
		state: { enum: ['complete', 'partial', 'refused'] },
		resolved: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['siteId', 'roles'],
				properties: {
					siteId: {
						type: 'string',
						pattern: '^[^:#]+(?:/[^:#]+)*:[1-9][0-9]*:[1-9][0-9]*#resolved$',
					},
					roles: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		unresolved: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['siteId', 'reason'],
				properties: {
					siteId: {
						type: 'string',
						pattern: '^[^:#]+(?:/[^:#]+)*:[1-9][0-9]*:[1-9][0-9]*#unresolved:[a-z-]+$',
					},
					reason: { type: 'string' },
				},
			},
		},
		reasoning: { type: 'string' },
	},
} as const;

function listFiles(root: string): string[] {
	const paths: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join('/'));
			else throw new Error(`non-regular preregistration path '${absolute}'`);
		}
	};
	visit(root);
	return paths.sort();
}

function ledger(root: string, excluded: ReadonlySet<string> = new Set()): unknown[] {
	return listFiles(root)
		.filter((path) => !excluded.has(path))
		.map((path) => {
			const bytes = readFileSync(join(root, path));
			return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
		});
}

function predecessorHash(repositoryRoot: string): Record<string, string> {
	const roots = [
		'packages/evaluation/fixtures/oracle-part-3-v3',
		'packages/evaluation/fixtures/oracle-part-3-v4',
		'packages/evaluation/fixtures/oracle-part-3-v5',
		'docs/evidence/oracle-part-3-v3',
		'docs/evidence/oracle-part-3-v4',
		'docs/evidence/oracle-part-3-v5',
	];
	return Object.fromEntries(
		roots.map((path) => {
			const absolute = join(repositoryRoot, path);
			return [path, existsSync(absolute) ? sha256(stableJson(ledger(absolute))) : 'absent'];
		}),
	);
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const sortedValue = JSON.parse(stableJson(value));
	writeFileSync(path, `${JSON.stringify(sortedValue, null, '\t')}\n`);
}

function writeIntegrityJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`);
}

export function generateV6Preregistration(
	archiveSource = '/tmp/guessless-v6-corpus-selection',
	moduleUrl = import.meta.url,
): void {
	const fixtureRoot = v6FixtureRoot(moduleUrl);
	if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
	mkdirSync(fixtureRoot, { recursive: true });
	copyVerifiedArchives(archiveSource, fixtureRoot);
	writeJson(join(fixtureRoot, 'acquisition-ledger.json'), {
		schema: 'guessless.v6-acquisition/v1',
		selectedBytes: 637_871,
		transparentAcquiredBytes: 672_904,
		candidates: [
			...V6_REPOSITORIES.map((repository) => ({
				id: repository.id,
				selected: true,
				archive: repository.archive,
				sha256: repository.archiveSha256,
				bytes: repository.archiveBytes,
				commit: repository.commit,
				licenseSha256: repository.licenseSha256,
			})),
			{
				id: 'klona',
				selected: false,
				archive: null,
				sha256: '153b4a4d808516c2afb1d814858a97f792ee42c9c114be3505120a4f9e3e7612',
				bytes: 35_033,
				reason: 'Discarded transparently before preregistration; not copied into the selected corpus.',
			},
		],
	});
	writeJson(join(fixtureRoot, 'tasks.json'), V6_TASKS);
	writeJson(join(fixtureRoot, 'prompts.json'), prompts());
	const order = buildOrder();
	writeJson(join(fixtureRoot, 'order.json'), order);
	writeJson(join(fixtureRoot, 'response.schema.json'), RESPONSE_SCHEMA);
	writeJson(join(fixtureRoot, 'fake-transcripts.json'), generateFakeV6Replay(order));
	writeJson(join(fixtureRoot, 'replay-contract.json'), {
		schema: 'guessless.v6-replay-contract/v1',
		liveExecutionAvailable: false,
		cellCommand: ['codex', 'exec', '--model', V6_MODEL, '--json', '--sandbox', 'read-only'],
		recorder:
			'Injected spawner -> ordered transcript -> delivery validation -> aggregate validation -> immutable seal.',
		replay: 'Verify exact cell IDs/order, transcript event matching, accounting, aggregate budgets, and seal before scoring.',
		sealing: 'No retry, replacement, prompt repair, rescore, or same-ID rerun path exists.',
	});
	const allTruth: unknown[] = [];
	const sourceLedgers: Record<string, unknown> = {};
	for (const repository of V6_REPOSITORIES) {
		const computed = computeRepositoryArtifacts(
			repository,
			join(fixtureRoot, 'archives', repository.archive),
		);
		allTruth.push(...computed.truth);
		sourceLedgers[repository.id] = computed.sourceLedger;
		for (const artifact of computed.artifacts) {
			writeCompressedJson(
				join(fixtureRoot, 'receipts', `${artifact.task.id}.full.json.gz`),
				artifact.full,
			);
			writeIntegrityJson(
				join(fixtureRoot, 'receipts', `${artifact.task.id}.summary.json`),
				artifact.summary,
			);
			writeCompressedJson(
				join(fixtureRoot, 'proofs', `${artifact.full.integrity}.json.gz`),
				artifact.full,
			);
		}
	}
	writeCompressedJson(join(fixtureRoot, 'ground-truth.json.gz'), allTruth);
	writeJson(join(fixtureRoot, 'source-ledgers.json'), sourceLedgers);
	const protocol = {
		schema: 'guessless.evaluation-preregistration/v6',
		evidenceId: V6_ID,
		executionAuthorized: false,
		model: V6_MODEL,
		codexVersion: V6_CODEX_VERSION,
		nodeVersion: V6_NODE_VERSION,
		pnpmVersion: V6_PNPM_VERSION,
		executables: {
			codex: { version: V6_CODEX_VERSION, sha256: V6_CODEX_EXECUTABLE_SHA256 },
			node: { version: V6_NODE_VERSION, sha256: V6_NODE_EXECUTABLE_SHA256 },
		},
		systemInstruction: V6_NEUTRAL_SYSTEM_INSTRUCTION,
		budgets: V6_BUDGETS,
		policy: V6_POLICY,
		orderSha256: sha256(readFileSync(join(fixtureRoot, 'order.json'))),
		promptsSha256: sha256(readFileSync(join(fixtureRoot, 'prompts.json'))),
		responseSchemaSha256: sha256(readFileSync(join(fixtureRoot, 'response.schema.json'))),
		fakeTranscriptsSha256: sha256(readFileSync(join(fixtureRoot, 'fake-transcripts.json'))),
		replayContractSha256: sha256(readFileSync(join(fixtureRoot, 'replay-contract.json'))),
		tasksSha256: sha256(readFileSync(join(fixtureRoot, 'tasks.json'))),
		groundTruthSha256: sha256(readFileSync(join(fixtureRoot, 'ground-truth.json.gz'))),
		scoring: V6_SCORING_GATES,
		environment: {
			sandbox: 'read-only',
			network: 'disabled',
			packageInstall: 'forbidden',
			userConfig: 'ignored',
			userRules: 'ignored',
			secrets: 'none',
			writableSource: false,
			freshTree: true,
			freshContext: true,
			freshMcpServer: true,
			freshSnapshot: true,
			crossCellState: false,
		},
		transcriptAccounting: {
			selection:
				'Count only delivered applicable prepare_snapshot and safe_change_impact results; starts and cancellations are separate.',
			proof: 'Every proof read is a separate follow-up tool/read and its tools, reported tokens, and elapsed time remain in cell totals.',
		},
		stops: {
			firstFailedCell: 'Seal partial NO_GO immediately because 71/72 is below 99%; no retry.',
			fatal: 'Any budget, security, environment, transcript, manifest, truth, or scoring-integrity breach seals NO_GO immediately.',
			noRetry: true,
			noReplacement: true,
			noRescore: true,
			noPromptRepair: true,
			noSameIdRerun: true,
		},
	};
	writeJson(join(fixtureRoot, 'protocol.json'), protocol);
	writeManifest(moduleUrl);
}

function externalPaths(packageRoot: string): string[] {
	const repositoryRoot = resolve(packageRoot, '../..');
	return [
		'packages/evaluation/package.json',
		'packages/evaluation/src/cli.ts',
		'packages/evaluation/src/v6-contracts.ts',
		'packages/evaluation/src/v6-corpus.ts',
		'packages/evaluation/src/v6-codex.ts',
		'packages/evaluation/src/v6-scoring.ts',
		'packages/evaluation/src/v6-preregistration.ts',
		'packages/evaluation/test/v6-evaluation.test.ts',
		'packages/evaluation/dist/cli.js',
		'packages/engine/dist/index.js',
		'packages/mcp/dist/server.js',
	].map((path) => join(repositoryRoot, path));
}

export function writeManifest(moduleUrl = import.meta.url): void {
	const fixtureRoot = v6FixtureRoot(moduleUrl);
	const packageRoot = evaluationPackageRoot(moduleUrl);
	const repositoryRoot = resolve(packageRoot, '../..');
	const files = ledger(fixtureRoot, new Set(['manifest.json']));
	const externals = externalPaths(packageRoot).map((absolute) => ({
		path: relative(repositoryRoot, absolute).split(sep).join('/'),
		bytes: statSync(absolute).size,
		sha256: sha256(readFileSync(absolute)),
	}));
	const unsigned = {
		schema: 'guessless.v6-preregistration-manifest/v1',
		evidenceId: V6_ID,
		files,
		executables: externals,
		predecessors: predecessorHash(repositoryRoot),
	};
	writeJson(join(fixtureRoot, 'manifest.json'), {
		...unsigned,
		integrity: sha256(stableJson(unsigned)),
	});
}

export function verifyV6Preregistration(
	moduleUrl = import.meta.url,
	fixtureRootOverride?: string,
	deep = true,
): {
	files: number;
	tasks: number;
	cells: number;
} {
	const fixtureRoot = fixtureRootOverride ?? v6FixtureRoot(moduleUrl);
	const packageRoot = evaluationPackageRoot(moduleUrl);
	const repositoryRoot = resolve(packageRoot, '../..');
	const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
		schema: string;
		evidenceId: string;
		files: unknown[];
		executables: { path: string; bytes: number; sha256: string }[];
		predecessors: Record<string, string>;
		integrity: string;
	};
	const { integrity, ...unsigned } = manifest;
	if (
		manifest.schema !== 'guessless.v6-preregistration-manifest/v1' ||
		manifest.evidenceId !== V6_ID ||
		integrity !== sha256(stableJson(unsigned)) ||
		stableJson(manifest.files) !==
			stableJson(ledger(fixtureRoot, new Set(['manifest.json']))) ||
		stableJson(manifest.predecessors) !== stableJson(predecessorHash(repositoryRoot))
	)
		throw new Error('v6 manifest verification failed');
	for (const external of manifest.executables) {
		const absolute = join(repositoryRoot, external.path);
		if (
			statSync(absolute).size !== external.bytes ||
			sha256(readFileSync(absolute)) !== external.sha256
		)
			throw new Error(`v6 executable mutation '${external.path}'`);
	}
	const tasks = JSON.parse(readFileSync(join(fixtureRoot, 'tasks.json'), 'utf8')) as V6Task[];
	const order = JSON.parse(readFileSync(join(fixtureRoot, 'order.json'), 'utf8')) as V6Cell[];
	if (stableJson(tasks) !== stableJson(V6_TASKS)) throw new Error('v6 task mutation');
	if (stableJson(order) !== stableJson(buildOrder()) || order.length !== 72)
		throw new Error('v6 order mutation');
	const replay = JSON.parse(
		readFileSync(join(fixtureRoot, 'fake-transcripts.json'), 'utf8'),
	) as V6SealedReplay;
	verifyV6Replay(order, replay);
	const replayContract = JSON.parse(
		readFileSync(join(fixtureRoot, 'replay-contract.json'), 'utf8'),
	) as { liveExecutionAvailable?: boolean };
	if (replayContract.liveExecutionAvailable !== false)
		throw new Error('v6 live replay path must remain unavailable');
	const promptText = readFileSync(join(fixtureRoot, 'prompts.json'), 'utf8');
	const parsedPrompts = JSON.parse(promptText) as Record<
		string,
		{ discovery: string; consumption: unknown }
	>;
	if (stableJson(parsedPrompts) !== stableJson(prompts())) throw new Error('v6 prompt mutation');
	for (const task of V6_TASKS) {
		if (parsedPrompts[task.id]?.discovery !== taskPrompt(task))
			throw new Error(`natural prompt mismatch '${task.id}'`);
		if (
			/guessless|oracle|mcp|safe[_ -]?change[_ -]?impact|prepare[_ -]?snapshot/i.test(
				taskPrompt(task),
			)
		)
			throw new Error(`natural prompt hints at treatment '${task.id}'`);
		const full = readCompressedJson(
			join(fixtureRoot, 'receipts', `${task.id}.full.json.gz`),
		) as {
			integrity: string;
			snapshot: string;
			state: string;
		};
		if (!verifyReceipt(full as never)) throw new Error(`full receipt invalid '${task.id}'`);
		const proof = readCompressedJson(join(fixtureRoot, 'proofs', `${full.integrity}.json.gz`));
		if (stableJson(full) !== stableJson(proof)) throw new Error(`proof mismatch '${task.id}'`);
		const summary = JSON.parse(
			readFileSync(join(fixtureRoot, 'receipts', `${task.id}.summary.json`), 'utf8'),
		) as { proofHandle: string; snapshot: string; state: string };
		if (!verifySafeChangeSummary(summary as never))
			throw new Error(`summary receipt invalid '${task.id}'`);
		if (summary.proofHandle !== full.integrity)
			throw new Error(`summary handle mismatch '${task.id}'`);
		if (summary.snapshot !== full.snapshot || summary.state !== full.state)
			throw new Error(`summary semantic binding mismatch '${task.id}'`);
	}
	const truth = readCompressedJson(join(fixtureRoot, 'ground-truth.json.gz')) as unknown[];
	if (truth.length !== 18) throw new Error('v6 truth task count mismatch');
	if (deep) {
		const recomputedTruth: unknown[] = [];
		const recomputedLedgers: Record<string, unknown> = {};
		for (const repository of V6_REPOSITORIES) {
			const computed = computeRepositoryArtifacts(
				repository,
				join(fixtureRoot, 'archives', repository.archive),
			);
			recomputedTruth.push(...computed.truth);
			recomputedLedgers[repository.id] = computed.sourceLedger;
			for (const artifact of computed.artifacts) {
				const full = readCompressedJson(
					join(fixtureRoot, 'receipts', `${artifact.task.id}.full.json.gz`),
				);
				const summaryBytes = readFileSync(
					join(fixtureRoot, 'receipts', `${artifact.task.id}.summary.json`),
					'utf8',
				);
				const directSummaryBytes = `${JSON.stringify(artifact.summary, null, '\t')}\n`;
				if (
					stableJson(full) !== stableJson(artifact.full) ||
					summaryBytes !== directSummaryBytes
				)
					throw new Error(`v6 recomputed artifact mismatch '${artifact.task.id}'`);
			}
		}
		if (stableJson(truth) !== stableJson(recomputedTruth))
			throw new Error('v6 recomputed truth mismatch');
		const sourceLedgers = JSON.parse(
			readFileSync(join(fixtureRoot, 'source-ledgers.json'), 'utf8'),
		);
		if (stableJson(sourceLedgers) !== stableJson(recomputedLedgers))
			throw new Error('v6 source ledger mismatch');
	}
	const staging = readdirSync(repositoryRoot).some((name) =>
		name.startsWith('.staging-oracle-part-3-v6-'),
	);
	if (staging || existsSync(join(repositoryRoot, 'docs/evidence/oracle-part-3-v6')))
		throw new Error('v6 evidence/staging path must remain absent');
	return { files: manifest.files.length, tasks: tasks.length, cells: order.length };
}
