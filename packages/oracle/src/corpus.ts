import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'pathe';
import type {
	GuesslessEngine as GuesslessEngineType,
	QueryRequest,
	Receipt,
	SymbolAnchor,
} from '../../engine/src/index.ts';
import { networkIsolatedCommand } from './contracts.ts';

const enginePackage: string = '@guessless/engine';
const { GuesslessEngine, receiptCanonicalForm } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

export interface SourceInput {
	readonly path: string;
	readonly source: string;
}

export interface GuesslessEvidence {
	readonly repository: string;
	readonly selectionAlgorithm: string;
	readonly indexedFiles: number;
	readonly indexedBytes: number;
	readonly target: SymbolAnchor;
	readonly comparisonPosition: {
		readonly file: string;
		readonly line: number;
		readonly character: number;
		readonly symbolName: string;
	};
	readonly query: string;
	readonly receipt: Receipt<unknown>;
	readonly integrityValid: boolean;
	readonly replayCanonical: boolean;
	readonly citations: readonly { readonly anchor: SymbolAnchor; readonly resolved: boolean }[];
}

export interface NonbuildEvidence {
	readonly repository: string;
	readonly selection: 'typecheck>build>test';
	readonly script: string;
	readonly command: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly networkIsolation: string;
	readonly status: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly scriptBannerReached: boolean;
	readonly expectedMissingToolingFailure: boolean;
	readonly stdout: string;
	readonly stderr: string;
}

const pnpmUsageFailures = [
	/Unknown option:/i,
	/For help, run: pnpm help/i,
	/ERR_PNPM_CONFIG/i,
	/Usage:\s*pnpm/i,
];
const harnessOrNetworkFailures = [
	/ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|fetch failed|ENOTCACHED|NotCachedError/i,
	/registry\.npmjs\.org|cache mode is 'only-if-cached'/i,
	/(^|\s)(?:npm|pnpm|yarn)\s+(?:i|install|add|update)(?:\s|$)/im,
	/guessless-oracle|sandbox-exec:|operation not permitted/i,
];
const missingToolingFailures = [
	/(?:^|\n)(?:\/bin\/)?sh: [A-Za-z0-9@._/-]+: (?:command )?not found(?:\n|$)/,
	/(?:Error(?: \[ERR_MODULE_NOT_FOUND\])?: )?Cannot find (?:module|package) ['"][^'"]+['"]/,
];

export function validateNonbuildEvidence(
	evidence: NonbuildEvidence,
	allowClosedPredecessor = false,
): void {
	const output = `${evidence.stdout}\n${evidence.stderr}`;
	const command = evidence.command;
	const runIndex = command.lastIndexOf('run');
	if (
		runIndex < 1 ||
		command[runIndex - 1] !== 'pnpm' ||
		command[runIndex + 1] !== evidence.script ||
		command.includes('--offline')
	)
		throw new Error(`${evidence.repository} nonbuild command mismatch`);
	const proxy = 'http://127.0.0.1:9';
	for (const key of [
		'http_proxy',
		'https_proxy',
		'all_proxy',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'ALL_PROXY',
	] as const)
		if (evidence.environment[key] !== proxy)
			throw new Error(`${evidence.repository} nonbuild proxy mismatch`);
	if (
		evidence.environment.npm_config_offline !== 'true' ||
		(!allowClosedPredecessor && evidence.environment.npm_config_ignore_scripts !== 'true') ||
		(!allowClosedPredecessor &&
			evidence.environment.npm_config_enable_pre_post_scripts !== 'false') ||
		evidence.environment.NO_PROXY === '*' ||
		evidence.environment.no_proxy === '*'
	)
		throw new Error(`${evidence.repository} nonbuild offline environment mismatch`);
	const mainBanner = new RegExp(`(^|\\n)>\\s+[^\\n]+\\s+${evidence.script}(\\s|$)`).test(
		evidence.stdout,
	);
	const lifecycleBanner = new RegExp(
		`(^|\\n)>\\s+[^\\n]+\\s+(?:pre|post)${evidence.script}(\\s|$)`,
	).test(evidence.stdout);
	const expectedFailure =
		missingToolingFailures.some((pattern) => pattern.test(output)) ||
		(allowClosedPredecessor &&
			/ENOTCACHED|NotCachedError|cache mode is 'only-if-cached'/i.test(output));
	if (
		evidence.status === 0 ||
		evidence.status === null ||
		evidence.signal !== null ||
		evidence.timedOut ||
		!(mainBanner || (allowClosedPredecessor && lifecycleBanner)) ||
		!evidence.scriptBannerReached ||
		evidence.scriptBannerReached !== (mainBanner || lifecycleBanner) ||
		!expectedFailure ||
		!evidence.expectedMissingToolingFailure ||
		evidence.expectedMissingToolingFailure !== expectedFailure ||
		(!allowClosedPredecessor && lifecycleBanner) ||
		pnpmUsageFailures.some((pattern) => pattern.test(output)) ||
		(!allowClosedPredecessor &&
			harnessOrNetworkFailures.some((pattern) => pattern.test(output)))
	)
		throw new Error(`${evidence.repository} nonbuild failure was not missing tooling`);
}

export function listSourceInputs(root: string): SourceInput[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && /\.(?:[cm]?[jt]s|jsx|tsx)$/.test(entry.name))
				files.push(path);
		}
	};
	visit(root);
	return files
		.sort()
		.map((path) => ({ path: relative(root, path), source: readFileSync(path, 'utf8') }));
}

function loadEngine(inputs: readonly SourceInput[]): GuesslessEngineType {
	const engine = new GuesslessEngine();
	for (const input of inputs) {
		const added = engine.addFile(input.path, input.source);
		if ('schema' in added)
			throw new Error(`supported source ${input.path} returned a ${added.state} receipt`);
	}
	engine.link();
	return engine;
}

function dispatch(engine: GuesslessEngineType, request: QueryRequest): Receipt<unknown> {
	switch (request.kind) {
		case 'definitionOf':
			return engine.definitionOf(request.target);
		case 'referencesOf':
			return engine.referencesOf(request.target);
		case 'readsOf':
			return engine.readsOf(request.target);
		case 'writesOf':
			return engine.writesOf(request.target);
		case 'exportedNames':
			return engine.exportedNames(request.file);
		case 'capturesOf':
			return engine.capturesOf(request.target);
		case 'resolveBinding':
			return engine.resolveBinding(
				request.file,
				request.name,
				request.space,
				request.scope ?? undefined,
			);
		case 'reachableFrom':
			return engine.reachableFrom(request.target);
		case 'reaches':
			return engine.reaches(request.target);
		default:
			throw new Error('addFile is not a corpus query');
	}
}

function anchorsIn(value: unknown): SymbolAnchor[] {
	const found = new Map<string, SymbolAnchor>();
	const visit = (item: unknown): void => {
		if (item === null || typeof item !== 'object') return;
		if (Array.isArray(item)) {
			for (const nested of item) visit(nested);
			return;
		}
		const record = item as Record<string, unknown>;
		if (
			record.schema === 'guessless.symbol-anchor/v1' &&
			typeof record.file === 'string' &&
			Array.isArray(record.semanticPath) &&
			typeof record.fingerprint === 'string'
		) {
			const anchor = record as unknown as SymbolAnchor;
			found.set(JSON.stringify(anchor), anchor);
			return;
		}
		for (const nested of Object.values(record)) visit(nested);
	};
	visit(value);
	return [...found.values()];
}

function candidateAnchors(
	engine: GuesslessEngineType,
	inputs: readonly SourceInput[],
): { readonly anchor: SymbolAnchor; readonly name: string }[] {
	const candidates: { anchor: SymbolAnchor; name: string }[] = [];
	for (const input of inputs) {
		if (input.path.split('/').some((component) => component.startsWith('.'))) continue;
		const names = [
			...new Set((engine.module(input.path)?.symbols ?? []).map((symbol) => symbol.name)),
		]
			.filter((name) => name.length > 0)
			.sort();
		for (const name of names) {
			const anchor = engine.anchor(input.path, name);
			if (anchor !== null) candidates.push({ anchor, name });
		}
	}
	return candidates;
}

function makeEvidence(
	repository: string,
	inputs: readonly SourceInput[],
	engine: GuesslessEngineType,
	request: Exclude<QueryRequest, { kind: 'addFile' }>,
	target: SymbolAnchor,
	symbolName: string,
): GuesslessEvidence {
	const receipt = dispatch(engine, request);
	const replay = loadEngine(inputs);
	const current = dispatch(replay, request);
	const citations = anchorsIn(receipt).map((anchor) => ({
		anchor,
		resolved: engine.resolve(anchor) !== null,
	}));
	if (citations.some((citation) => !citation.resolved))
		throw new Error(`${repository} emitted an unresolvable citation for ${request.kind}`);
	const input = inputs.find((candidate) => candidate.path === target.file);
	if (input === undefined) throw new Error(`target file ${target.file} was not indexed`);
	const offset = input.source.search(
		new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
	);
	if (offset < 0) throw new Error(`target text ${symbolName} is absent from ${target.file}`);
	const before = input.source.slice(0, offset).split('\n');
	return {
		repository,
		selectionAlgorithm:
			'lexicographic source path, then unique symbol name; first anchor with non-empty definition and references; first non-empty captures/reachable Tier-2 result',
		indexedFiles: inputs.length,
		indexedBytes: inputs.reduce((sum, input) => sum + Buffer.byteLength(input.source), 0),
		target,
		comparisonPosition: {
			file: target.file,
			line: before.length,
			character: (before.at(-1)?.length ?? 0) + 1,
			symbolName,
		},
		query: request.kind,
		receipt,
		integrityValid: engine.verify(receipt),
		replayCanonical:
			replay.verify(receipt) &&
			receiptCanonicalForm(current) === receiptCanonicalForm(receipt),
		citations,
	};
}

export function recordGuessless(repository: string, root: string): GuesslessEvidence[] {
	const inputs = listSourceInputs(root);
	if (inputs.length === 0) throw new Error(`${repository} contains no JS/TS source inputs`);
	const engine = loadEngine(inputs);
	const candidates = candidateAnchors(engine, inputs);
	let selected: (typeof candidates)[number] | undefined;
	for (const candidate of candidates) {
		if (
			engine.definitionOf(candidate.anchor).results.length > 0 &&
			engine.referencesOf(candidate.anchor).results.length > 0
		) {
			selected = candidate;
			break;
		}
	}
	if (selected === undefined)
		throw new Error(`${repository} has no deterministic non-empty definition/reference target`);
	const evidence = [
		makeEvidence(
			repository,
			inputs,
			engine,
			{ kind: 'definitionOf', target: selected.anchor },
			selected.anchor,
			selected.name,
		),
		makeEvidence(
			repository,
			inputs,
			engine,
			{ kind: 'referencesOf', target: selected.anchor },
			selected.anchor,
			selected.name,
		),
	];
	for (const candidate of candidates) {
		const captures = engine.capturesOf(candidate.anchor);
		if (captures.results.length > 0) {
			evidence.push(
				makeEvidence(
					repository,
					inputs,
					engine,
					{ kind: 'capturesOf', target: candidate.anchor },
					candidate.anchor,
					candidate.name,
				),
			);
			break;
		}
		const reachable = engine.reachableFrom(candidate.anchor);
		if (reachable.results.length > 0) {
			evidence.push(
				makeEvidence(
					repository,
					inputs,
					engine,
					{ kind: 'reachableFrom', target: candidate.anchor },
					candidate.anchor,
					candidate.name,
				),
			);
			break;
		}
	}
	if (
		evidence.length < 2 ||
		evidence.some(
			(item) =>
				item.receipt.results.length === 0 || !item.integrityValid || !item.replayCanonical,
		)
	)
		throw new Error(`${repository} failed useful receipt requirements`);
	return evidence;
}

export function runNonbuild(repository: string, root: string): NonbuildEvidence {
	const packagePath = join(root, 'package.json');
	if (!statSync(packagePath).isFile()) throw new Error(`${repository} lacks package.json`);
	const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
		scripts?: Record<string, string>;
	};
	const script = ['typecheck', 'build', 'test'].find((name) => packageJson.scripts?.[name]);
	if (script === undefined)
		throw new Error(`${repository} has no typecheck, build, or test script`);
	const scratch = mkdtempSync(join(tmpdir(), `guessless-${repository}-`));
	const checkout = join(scratch, basename(root));
	try {
		cpSync(root, checkout, { recursive: true, errorOnExist: true });
		const isolated = networkIsolatedCommand(['pnpm', 'run', script], scratch);
		const command = isolated.command;
		const proxy = 'http://127.0.0.1:9';
		const environment = {
			CI: '1',
			npm_config_offline: 'true',
			npm_config_ignore_scripts: 'true',
			npm_config_enable_pre_post_scripts: 'false',
			http_proxy: proxy,
			https_proxy: proxy,
			all_proxy: proxy,
			HTTP_PROXY: proxy,
			HTTPS_PROXY: proxy,
			ALL_PROXY: proxy,
			NO_PROXY: '',
			no_proxy: '',
		};
		const result = spawnSync(command[0], command.slice(1), {
			cwd: checkout,
			encoding: 'utf8',
			env: { ...process.env, ...environment },
			timeout: 120_000,
			maxBuffer: 32 * 1024 * 1024,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		const evidence: NonbuildEvidence = {
			repository,
			selection: 'typecheck>build>test',
			script,
			command,
			environment,
			networkIsolation: isolated.mechanism,
			status: result.status,
			signal: result.signal,
			timedOut: result.error?.message.includes('ETIMEDOUT') ?? false,
			scriptBannerReached: new RegExp(`(^|\\n)>\\s+[^\\n]+\\s+${script}(\\s|$)`).test(
				result.stdout,
			),
			expectedMissingToolingFailure: missingToolingFailures.some((pattern) =>
				pattern.test(output),
			),
			stdout: result.stdout,
			stderr: result.stderr,
		};
		validateNonbuildEvidence(evidence);
		return evidence;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
