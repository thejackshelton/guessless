import { spawnSync } from 'node:child_process';
import {
	chmodSync,
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
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SafeChangePageCache, makeSafeChangePagedBundle } from '../../mcp/src/page-cache.ts';
import type { Receipt, SafeChangeImpactResult } from '../../engine/src/index.ts';
import {
	V10_BUDGETS,
	V10_CODEX_EXECUTABLE_SHA256,
	V10_CODEX_VERSION,
	V10_MAX_ANSWER_BYTES,
	V10_MAX_SEAL_BYTES,
	V10_MODEL,
	V10_NEUTRAL_SYSTEM_INSTRUCTION,
	V10_NODE_EXECUTABLE_SHA256,
	V10_NODE_VERSION,
	V10_PNPM_VERSION,
	V10_POLICY,
	V10_REPOSITORIES,
	V10_RESPONSE_SCHEMA,
	V10_SCORING_GATES,
	V10_SEAL_SCHEMA,
	V10_TASKS,
	buildV10Order,
	buildV10Prompts,
	sha256,
	stableJson,
	v10EvidenceRoot,
	v10FixtureRoot,
	v10RepositoryRoot,
	type V10AnswerSeal,
	type V10Cell,
} from './v10-contracts.ts';
import {
	assertCodexVersion,
	fakeV10Preflight,
	readFinalSeal,
	sealV10Replay,
	spawnV10Cell,
	type V10DeliveryAccounting,
	type V10ReplayRecord,
} from './v10-codex.ts';
import {
	decideV10,
	scoreV10Response,
	validateV10Response,
	type V10RecordedCell,
	type V10TruthShape,
} from './v10-scoring.ts';

interface ManifestEntry {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

interface V10Manifest {
	readonly schema: 'guessless.v10-manifest/v1';
	readonly files: readonly ManifestEntry[];
	readonly externals: readonly ManifestEntry[];
	readonly predecessors: Readonly<Record<string, string>>;
	readonly integrity: string;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const sortedValue = JSON.parse(stableJson(value));
	writeFileSync(path, `${JSON.stringify(sortedValue, null, '\t')}\n`);
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
			else throw new Error(`v10 non-regular path '${absolute}'`);
		}
	};
	visit(root);
	return files.sort();
}

function ledger(root: string, excluded = new Set<string>()): ManifestEntry[] {
	return listFiles(root)
		.filter((path) => !excluded.has(path))
		.map((path) => {
			const bytes = readFileSync(join(root, path));
			return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
		});
}

function treeDigest(path: string): string {
	return existsSync(path) ? sha256(stableJson(ledger(path))) : 'absent';
}

function predecessorHashes(repositoryRoot: string): Record<string, string> {
	return Object.fromEntries(
		[
			'packages/evaluation/fixtures/oracle-part-3-v3',
			'packages/evaluation/fixtures/oracle-part-3-v4',
			'packages/evaluation/fixtures/oracle-part-3-v5',
			'packages/evaluation/fixtures/oracle-part-3-v6',
			'packages/evaluation/fixtures/oracle-part-3-v7',
			'packages/evaluation/fixtures/oracle-part-3-v8',
			'packages/evaluation/fixtures/oracle-part-3-v9',
			'docs/evidence/oracle-part-3-v3',
			'docs/evidence/oracle-part-3-v4',
			'docs/evidence/oracle-part-3-v5',
			'docs/evidence/oracle-part-3-v6',
			'docs/evidence/oracle-part-3-v7',
			'docs/evidence/oracle-part-3-v8',
			'docs/evidence/oracle-part-3-v9',
		].map((path) => [path, treeDigest(join(repositoryRoot, path))]),
	);
}

function assertSafeArchive(archive: string): void {
	const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
	if (listed.status !== 0) throw new Error(`v10 cannot list archive '${archive}'`);
	for (const entry of listed.stdout.split('\n').filter(Boolean))
		if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\0'))
			throw new Error(`v10 unsafe archive entry '${entry}'`);
}

function makeReadOnly(root: string): void {
	for (const path of listFiles(root)) chmodSync(join(root, path), 0o444);
	const directories: string[] = [];
	const visit = (directory: string): void => {
		directories.push(directory);
		for (const entry of readdirSync(directory, { withFileTypes: true }))
			if (entry.isDirectory()) visit(join(directory, entry.name));
	};
	visit(root);
	for (const directory of directories.sort((left, right) => right.length - left.length))
		chmodSync(directory, 0o555);
}

function makeWritableForRemoval(root: string): void {
	if (!existsSync(root)) return;
	const visit = (path: string): void => {
		chmodSync(path, lstatSync(path).isDirectory() ? 0o755 : 0o644);
		if (lstatSync(path).isDirectory())
			for (const entry of readdirSync(path)) visit(join(path, entry));
	};
	visit(root);
}

function fixtureExternals(repositoryRoot: string): string[] {
	return [
		'packages/evaluation/src/v10-contracts.ts',
		'packages/evaluation/src/v10-codex.ts',
		'packages/evaluation/src/v10-runner.ts',
		'packages/evaluation/src/v10-scoring.ts',
		'packages/evaluation/test/v10-evaluation.test.ts',
		'packages/engine/dist/index.js',
		'packages/mcp/dist/server.js',
		'packages/mcp/dist/src-DnFJEf5U.js',
	].map((path) => join(repositoryRoot, path));
}

function writeManifest(fixtureRoot: string): void {
	const repositoryRoot = v10RepositoryRoot();
	const files = ledger(fixtureRoot, new Set(['manifest.json']));
	const externals = fixtureExternals(repositoryRoot).map((path) => {
		const bytes = readFileSync(path);
		return {
			path: relative(repositoryRoot, path).split(sep).join('/'),
			bytes: bytes.byteLength,
			sha256: sha256(bytes),
		};
	});
	const unsigned = {
		schema: 'guessless.v10-manifest/v1' as const,
		files,
		externals,
		predecessors: predecessorHashes(repositoryRoot),
	};
	writeJson(join(fixtureRoot, 'manifest.json'), {
		...unsigned,
		integrity: sha256(stableJson(unsigned)),
	});
}

function copyCorpus(repositoryId: string, archiveRoot: string, destinationRoot: string): void {
	const repository = V10_REPOSITORIES.find((candidate) => candidate.id === repositoryId)!;
	const archive = join(archiveRoot, repository.archive);
	assertSafeArchive(archive);
	const temporary = mkdtempSync(join(tmpdir(), `guessless-v10-${repository.id}-`));
	try {
		const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], {
			encoding: 'utf8',
		});
		if (extracted.status !== 0) throw new Error(`v10 cannot extract '${repository.archive}'`);
		const source = join(temporary, repository.rootDirectory, repository.sourceDirectory);
		const destination = join(destinationRoot, repository.id, repository.sourceDirectory);
		cpSync(source, destination, { recursive: true, dereference: false });
		for (const path of listFiles(join(destinationRoot, repository.id))) {
			const absolute = join(destinationRoot, repository.id, path);
			if (lstatSync(absolute).isSymbolicLink())
				throw new Error('v10 corpus contains symlink');
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function materializeArtifacts(fixtureRoot: string): void {
	const v6Root = join(dirname(fixtureRoot), 'oracle-part-3-v6');
	for (const task of V10_TASKS) {
		const receipt = JSON.parse(
			gunzipSync(readFileSync(join(v6Root, 'receipts', `${task.id}.full.json.gz`))).toString(
				'utf8',
			),
		) as Receipt<SafeChangeImpactResult>;
		const taskRoot = join(fixtureRoot, 'artifacts', task.id);
		mkdirSync(join(taskRoot, 'full'), { recursive: true });
		writeFileSync(join(taskRoot, 'full', 'receipt.bin'), JSON.stringify(receipt));
		const bundle = makeSafeChangePagedBundle(receipt);
		const cache = new SafeChangePageCache();
		const head = cache.set(bundle) as {
			state: string;
			semantic: { firstCursor: string };
			proof: { firstCursor: string };
		};
		if (head.state === 'refused') throw new Error(`v10 paged artifact refused '${task.id}'`);
		const pagedRoot = join(taskRoot, 'paged');
		mkdirSync(pagedRoot, { recursive: true });
		writeJson(join(pagedRoot, 'head.json'), head);
		const semanticLines: string[] = [];
		let cursor: string | undefined = head.semantic.firstCursor;
		do {
			const page = cache.page({
				pageHandle: receipt.integrity,
				stream: 'semantic',
				cursor,
			}) as { state: string; nextCursor?: string | null };
			if (page.state !== 'complete')
				throw new Error(`v10 semantic artifact refused '${task.id}'`);
			semanticLines.push(JSON.stringify(page));
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		writeFileSync(join(pagedRoot, 'semantic-pages.jsonl'), `${semanticLines.join('\n')}\n`);
		writeFileSync(join(pagedRoot, 'proof.bin'), bundle.proof);
	}
}

export function prepareV10Fixture(): void {
	const fixtureRoot = v10FixtureRoot();
	makeWritableForRemoval(fixtureRoot);
	rmSync(fixtureRoot, { recursive: true, force: true });
	mkdirSync(fixtureRoot, { recursive: true });
	const v6Root = join(dirname(fixtureRoot), 'oracle-part-3-v6');
	let acquiredBytes = 0;
	for (const repository of V10_REPOSITORIES) {
		const source = join(v6Root, 'archives', repository.archive);
		const target = join(fixtureRoot, 'archives', repository.archive);
		const bytes = readFileSync(source);
		if (
			sha256(bytes) !== repository.archiveSha256 ||
			bytes.byteLength !== repository.archiveBytes
		)
			throw new Error(`v10 archive identity mismatch '${repository.id}'`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
		acquiredBytes += bytes.byteLength;
	}
	cpSync(join(v6Root, 'ground-truth.json.gz'), join(fixtureRoot, 'ground-truth.json.gz'));
	writeJson(join(fixtureRoot, 'tasks.json'), V10_TASKS);
	writeJson(join(fixtureRoot, 'order.json'), buildV10Order());
	writeJson(join(fixtureRoot, 'prompts.json'), buildV10Prompts());
	writeJson(join(fixtureRoot, 'response.schema.bin'), V10_RESPONSE_SCHEMA);
	writeJson(join(fixtureRoot, 'seal.schema.bin'), V10_SEAL_SCHEMA);
	writeJson(join(fixtureRoot, 'protocol.json'), {
		schema: 'guessless.evaluation-preregistration/v10',
		executionAuthorized: true,
		model: V10_MODEL,
		codexVersion: V10_CODEX_VERSION,
		nodeVersion: V10_NODE_VERSION,
		pnpmVersion: V10_PNPM_VERSION,
		budgets: V10_BUDGETS,
		policy: V10_POLICY,
		scoring: V10_SCORING_GATES,
		acquiredBytes,
		incrementalDirectSpendUsd: 0,
		modelNetwork: 'disabled',
		providerAccess: 'authorized',
	});
	materializeArtifacts(fixtureRoot);
	writeManifest(fixtureRoot);
	makeReadOnly(join(fixtureRoot, 'archives'));
	makeReadOnly(join(fixtureRoot, 'artifacts'));
}

export function verifyV10Fixture(fixtureRoot = v10FixtureRoot()): {
	files: number;
	tasks: number;
	cells: number;
} {
	const manifest = JSON.parse(
		readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'),
	) as V10Manifest;
	const { integrity, ...unsigned } = manifest;
	if (
		manifest.schema !== 'guessless.v10-manifest/v1' ||
		integrity !== sha256(stableJson(unsigned)) ||
		stableJson(manifest.files) !== stableJson(ledger(fixtureRoot, new Set(['manifest.json'])))
	)
		throw new Error('v10 manifest mismatch');
	const repositoryRoot = v10RepositoryRoot();
	for (const external of manifest.externals) {
		const bytes = readFileSync(join(repositoryRoot, external.path));
		if (bytes.byteLength !== external.bytes || sha256(bytes) !== external.sha256)
			throw new Error(`v10 external mutation '${external.path}'`);
	}
	if (stableJson(manifest.predecessors) !== stableJson(predecessorHashes(repositoryRoot)))
		throw new Error('v10 predecessor mutation');
	const tasks = JSON.parse(readFileSync(join(fixtureRoot, 'tasks.json'), 'utf8')) as unknown[];
	const order = JSON.parse(readFileSync(join(fixtureRoot, 'order.json'), 'utf8')) as V10Cell[];
	const prompts = readFileSync(join(fixtureRoot, 'prompts.json'), 'utf8');
	if (stableJson(tasks) !== stableJson(V10_TASKS)) throw new Error('v10 task mutation');
	if (stableJson(order) !== stableJson(buildV10Order()) || order.length !== 4)
		throw new Error('v10 order mutation');
	if (stableJson(JSON.parse(prompts)) !== stableJson(buildV10Prompts()))
		throw new Error('v10 prompt mutation');
	if (/guessless|oracle|mcp|safe[_ -]?change|prepare[_ -]?snapshot/i.test(prompts))
		throw new Error('v10 prompt hints at treatment');
	for (const root of ['archives', 'artifacts'])
		for (const path of [
			join(fixtureRoot, root),
			...listFiles(join(fixtureRoot, root)).map((file) => join(fixtureRoot, root, file)),
		])
			if (lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o222) !== 0)
				throw new Error(`v10 mutable or linked fixture '${path}'`);
	return { files: manifest.files.length, tasks: tasks.length, cells: order.length };
}

function executablePath(name: string): string {
	const result = spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`v10 missing executable '${name}'`);
	return realpathSync(result.stdout.trim());
}

export function preflightV10(): Record<string, unknown> {
	const fixture = verifyV10Fixture();
	const codex = executablePath('codex');
	const node = executablePath('node');
	const version = spawnSync(codex, ['--version'], { encoding: 'utf8' });
	assertCodexVersion(version.stdout);
	const login = spawnSync(codex, ['login', 'status'], { encoding: 'utf8' });
	if (login.status !== 0 || !/Logged in using ChatGPT/.test(login.stdout + login.stderr))
		throw new Error('v10 Codex login preflight failed');
	if (sha256(readFileSync(codex)) !== V10_CODEX_EXECUTABLE_SHA256)
		throw new Error('v10 Codex executable hash mismatch');
	if (sha256(readFileSync(node)) !== V10_NODE_EXECUTABLE_SHA256)
		throw new Error('v10 Node executable hash mismatch');
	const fake = fakeV10Preflight(buildV10Order());
	if (
		fake.spawnedOnFailure !== 1 ||
		fake.unrunOnFailure !== 3 ||
		fake.firstFailure.outcome !== 'partial-NO_GO' ||
		fake.allSuccess.outcome !== 'complete'
	)
		throw new Error('v10 fake topology mismatch');
	return { fixture, codex, node, fake: { spawned: 1, unrun: 3 }, calibrationCalls: 0 };
}

function taskTruth(): Map<string, V10TruthShape> {
	const truth = JSON.parse(
		gunzipSync(readFileSync(join(v10FixtureRoot(), 'ground-truth.json.gz'))).toString('utf8'),
	) as V10TruthShape[];
	return new Map(truth.map((entry) => [entry.task.id, entry]));
}

function artifactBytes(root: string): number {
	return listFiles(root).reduce((sum, file) => sum + statSync(join(root, file)).size, 0);
}

function cellPrompt(
	cell: V10Cell,
	answerDirectory: string,
	corpus: string,
	artifact?: string,
): string {
	const task = V10_TASKS.find((candidate) => candidate.id === cell.taskId)!;
	const prompts = buildV10Prompts()[task.id] as {
		discovery: string;
		consumption: { full: string; paged: string };
	};
	const taskText =
		cell.kind === 'discovery'
			? prompts.discovery
			: prompts.consumption[cell.arm as 'full' | 'paged'];
	return `${V10_NEUTRAL_SYSTEM_INSTRUCTION}\n\n${taskText}\n\nThe read-only repository root is ${corpus}.${cell.kind === 'consumption' ? ` The read-only artifact root is ${artifact}.` : ''}\nWrite answer.json with exactly the fields state, resolved, unresolved, and reasoning. Each resolved item has exactly siteId and roles; each unresolved item has exactly siteId and reason. Write it to ${join(answerDirectory, 'answer.json')}, the only writable answer directory. Then compute its exact UTF-8 byte count and SHA-256 and return only a seal object with schema guessless.v10-answer-seal/v1, taskId ${task.id}, path answer.json, bytes, and sha256. The final seal must be at most 512 UTF-8 bytes. Do not access the network, install anything, or write elsewhere.`;
}

function validateAnswer(answerDirectory: string, taskId: string, finalText: string): unknown {
	const answerPath = join(answerDirectory, 'answer.json');
	const stat = lstatSync(answerPath);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.size < 1 ||
		stat.size > V10_MAX_ANSWER_BYTES
	)
		throw new Error('v10 answer file contract failed');
	const relativePath = relative(realpathSync(answerDirectory), realpathSync(answerPath));
	if (relativePath !== 'answer.json') throw new Error('v10 answer escaped directory');
	const answerBytes = readFileSync(answerPath);
	const answer = validateV10Response(JSON.parse(answerBytes.toString('utf8')));
	const sealBytes = Buffer.byteLength(finalText, 'utf8');
	if (sealBytes < 1 || sealBytes > V10_MAX_SEAL_BYTES)
		throw new Error('v10 final seal size failed');
	const seal = JSON.parse(finalText) as V10AnswerSeal;
	const writtenSeal = readFinalSeal(answerDirectory);
	if (stableJson(seal) !== stableJson(writtenSeal))
		throw new Error('v10 final seal delivery mismatch');
	if (
		Object.keys(seal).sort().join() !==
			['bytes', 'path', 'schema', 'sha256', 'taskId'].join() ||
		seal.schema !== 'guessless.v10-answer-seal/v1' ||
		seal.taskId !== taskId ||
		seal.path !== 'answer.json' ||
		seal.bytes !== answerBytes.byteLength ||
		seal.sha256 !== sha256(answerBytes)
	)
		throw new Error('v10 answer seal mismatch');
	return answer;
}

function assertAggregate(accounting: readonly V10DeliveryAccounting[]): void {
	const sum = (field: 'toolCalls' | 'reportedTokens' | 'durationMs') =>
		accounting.reduce((total, item) => total + item[field], 0);
	if (
		sum('toolCalls') > V10_BUDGETS.aggregate.maxToolCalls ||
		sum('reportedTokens') > V10_BUDGETS.aggregate.maxReportedTokens ||
		sum('durationMs') > V10_BUDGETS.aggregate.maxDurationMs
	)
		throw new Error('v10 aggregate budget exceeded');
}

function sealEvidence(
	evidenceRoot: string,
	staging: string,
	replay: ReturnType<typeof sealV10Replay>,
	cells: readonly V10RecordedCell[],
	failure?: string,
): void {
	const decision =
		failure === undefined ? decideV10(cells) : { decision: 'NO_GO', gates: {}, metrics: {} };
	writeJson(join(staging, 'replay.json'), replay);
	writeJson(join(staging, 'scores.json'), cells);
	writeJson(join(staging, 'decision.json'), { ...decision, failure: failure ?? null });
	const files = ledger(staging, new Set(['terminal.json']));
	writeJson(join(staging, 'terminal.json'), {
		schema: 'guessless.v10-evidence/v1',
		outcome: replay.outcome,
		decision: decision.decision,
		files,
		integrity: sha256(
			stableJson({ outcome: replay.outcome, decision: decision.decision, files }),
		),
	});
	const run = join(evidenceRoot, 'run');
	renameSync(staging, run);
	const seal = readFileSync(join(run, 'terminal.json'));
	writeFileSync(join(evidenceRoot, 'seal.json.tmp'), seal);
	renameSync(join(evidenceRoot, 'seal.json.tmp'), join(evidenceRoot, 'seal.json'));
}

export async function runV10Live(): Promise<void> {
	preflightV10();
	const evidenceRoot = v10EvidenceRoot();
	if (existsSync(evidenceRoot)) throw new Error('v10 evidence already exists; rerun forbidden');
	mkdirSync(evidenceRoot, { recursive: false });
	const staging = join(evidenceRoot, '.staging');
	mkdirSync(staging);
	mkdirSync(join(staging, 'transcripts'));
	const corpusBase = join(staging, 'corpora');
	for (const repository of V10_REPOSITORIES)
		copyCorpus(repository.id, join(v10FixtureRoot(), 'archives'), corpusBase);
	makeReadOnly(corpusBase);
	const order = buildV10Order();
	const truth = taskTruth();
	const completed: V10ReplayRecord[] = [];
	const scored: V10RecordedCell[] = [];
	const codexExecutable = executablePath('codex');
	const nodeExecutable = executablePath('node');
	const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME!, '.codex');
	const mcpServerPath = join(v10RepositoryRoot(), 'packages', 'mcp', 'dist', 'server.js');
	let failure: string | undefined;
	for (const cell of order) {
		const answerDirectory = join(staging, 'answers', cell.id);
		mkdirSync(join(answerDirectory, 'home'), { recursive: true });
		try {
			const task = V10_TASKS.find((candidate) => candidate.id === cell.taskId)!;
			const corpusRoot = join(corpusBase, task.repository);
			const artifactRoot =
				cell.kind === 'consumption'
					? join(v10FixtureRoot(), 'artifacts', task.id, cell.arm)
					: corpusRoot;
			const result = await spawnV10Cell({
				cell,
				prompt: cellPrompt(
					cell,
					answerDirectory,
					corpusRoot,
					cell.kind === 'consumption' ? artifactRoot : undefined,
				),
				answerDirectory,
				sealSchemaPath: join(v10FixtureRoot(), 'seal.schema.bin'),
				corpusRoot,
				mcpServerPath,
				nodeExecutable,
				codexExecutable,
				codexHome,
				production: cell.kind === 'discovery' && cell.arm === 'production',
				stdoutPath: join(staging, 'transcripts', `${cell.id}.jsonl`),
				stderrPath: join(staging, 'transcripts', `${cell.id}.stderr`),
			});
			if (result.exitCode !== 0 || result.signal !== null || result.inspection.failed)
				throw new Error(
					`Codex terminal failure exit=${result.exitCode} signal=${result.signal}`,
				);
			const answer = validateAnswer(answerDirectory, task.id, result.inspection.finalText);
			const cellScore = scoreV10Response(truth.get(task.id)!, answer);
			const delivery = result.inspection.accounting;
			completed.push({ cellId: cell.id, status: 'completed', accounting: delivery });
			scored.push({
				id: cell.id,
				taskId: cell.taskId,
				intent: task.intent,
				kind: cell.kind,
				arm: cell.arm,
				score: cellScore,
				delivery,
				initialBytes:
					cell.kind === 'consumption'
						? statSync(
								join(
									artifactRoot,
									cell.arm === 'full' ? 'receipt.bin' : 'head.json',
								),
							).size
						: 0,
				semanticCalls:
					delivery.deliveredApplicablePrepare + delivery.deliveredApplicableImpact,
				warmSemanticCalls: Math.max(0, delivery.deliveredApplicableImpact - 1),
				artifactBytes: artifactBytes(artifactRoot),
			});
			assertAggregate(completed.map((record) => record.accounting!));
			writeJson(join(staging, 'checkpoint.json'), {
				completed: completed.length,
				lastCell: cell.id,
				accounting: completed.map((record) => record.accounting),
			});
			process.stdout.write(
				`${JSON.stringify({ type: 'v10.checkpoint', completed: completed.length, cell: cell.id })}\n`,
			);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			completed.push({
				cellId: cell.id,
				status: 'completed',
				accounting: null,
				reason: failure,
			});
			break;
		}
	}
	const replay = sealV10Replay(order, completed, failure);
	sealEvidence(evidenceRoot, staging, replay, scored, failure);
	if (failure !== undefined) throw new Error(`v10 live partial NO_GO: ${failure}`);
}

export function verifyV10Evidence(): Record<string, unknown> {
	const root = join(v10EvidenceRoot(), 'run');
	const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as {
		files: ManifestEntry[];
		integrity: string;
		outcome: string;
		decision: string;
	};
	const files = ledger(root, new Set(['terminal.json']));
	if (
		stableJson(files) !== stableJson(terminal.files) ||
		terminal.integrity !==
			sha256(stableJson({ outcome: terminal.outcome, decision: terminal.decision, files }))
	)
		throw new Error('v10 evidence seal mismatch');
	const replay = JSON.parse(readFileSync(join(root, 'replay.json'), 'utf8')) as {
		integrity: string;
		[key: string]: unknown;
	};
	const { integrity, ...unsigned } = replay;
	if (integrity !== sha256(stableJson(unsigned))) throw new Error('v10 replay seal mismatch');
	if (existsSync(join(v10EvidenceRoot(), '.staging'))) throw new Error('v10 staging residue');
	return { outcome: terminal.outcome, decision: terminal.decision, files: files.length };
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === 'prepare') prepareV10Fixture();
	else if (command === 'verify') process.stdout.write(`${JSON.stringify(verifyV10Fixture())}\n`);
	else if (command === 'preflight') process.stdout.write(`${JSON.stringify(preflightV10())}\n`);
	else if (command === 'live') await runV10Live();
	else if (command === 'verify-evidence')
		process.stdout.write(`${JSON.stringify(verifyV10Evidence())}\n`);
	else throw new Error('usage: v10-runner.ts prepare|verify|preflight|live|verify-evidence');
}

if (basename(process.argv[1] ?? '') === basename(new URL(import.meta.url).pathname)) await main();
