import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import type {
	GuesslessEngine as GuesslessEngineType,
	Receipt,
	ReferenceResult,
	ReachabilityResult,
	SafeChangeImpactResult,
	SafeChangeRole,
	SafeChangeSummary,
	SymbolAnchor,
	UnresolvedSite,
} from '../../engine/src/index.ts';

const enginePackage: string = '@guessless/engine';
const {
	GuesslessEngine,
	SAFE_CHANGE_ROLES,
	anchorSite,
	canonicalize,
	resolveSiteAnchor,
	resolveSymbolAnchor,
	verifyReceipt,
	verifySafeChangeSummary,
} = (await import(enginePackage)) as typeof import('../../engine/src/index.ts');
import {
	V6_REPOSITORIES,
	V6_ROLES,
	V6_TASKS,
	V6_UNRESOLVED_REASONS,
	sha256,
	stableJson,
	type V6Repository,
	type V6Task,
} from './v6-contracts.ts';

export interface V6TruthSite {
	readonly id: string;
	readonly coordinate: string;
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lexeme: string;
	readonly lexemeSha256: string;
	readonly anchors: readonly SymbolAnchor[];
	readonly roles?: readonly string[];
	readonly reason?: string;
	readonly detail?: string;
	readonly rationale: string;
}

export interface V6TaskTruth {
	readonly task: V6Task;
	readonly state: 'complete' | 'partial';
	readonly snapshot: string;
	readonly resolved: readonly V6TruthSite[];
	readonly unresolved: readonly V6TruthSite[];
	readonly sourceAdjudication: 'Exact archive UTF-8 bytes plus independently composed definition/reference/reachability and import/export analysis enumerate canonical facts; the production safe-change receipt is retained only as a parity cross-check.';
}

export interface V6TaskArtifact {
	readonly task: V6Task;
	readonly full: Receipt<SafeChangeImpactResult>;
	readonly summary: SafeChangeSummary;
}

export function evaluationPackageRoot(moduleUrl: string = import.meta.url): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function v6FixtureRoot(moduleUrl: string = import.meta.url): string {
	return join(evaluationPackageRoot(moduleUrl), 'fixtures', 'oracle-part-3-v6');
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
			else throw new Error(`non-regular archive entry '${absolute}'`);
		}
	};
	visit(root);
	return files.sort();
}

function safeExtract(archive: string, destination: string): void {
	const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
	if (listed.status !== 0) throw new Error(`cannot list archive '${archive}'`);
	for (const entry of listed.stdout.split('\n').filter(Boolean))
		if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\0'))
			throw new Error(`unsafe archive entry '${entry}'`);
	const extracted = spawnSync('tar', ['-xzf', archive, '-C', destination], {
		encoding: 'utf8',
	});
	if (extracted.status !== 0) throw new Error(`cannot extract archive '${archive}'`);
}

function assertContained(root: string, candidate: string): void {
	const from = relative(realpathSync(root), realpathSync(candidate));
	if (from === '..' || from.startsWith(`..${sep}`)) throw new Error('archive path escape');
}

function sourceFiles(repositoryRoot: string, sourceDirectory: string): string[] {
	return listFiles(join(repositoryRoot, sourceDirectory))
		.map((path) => `${sourceDirectory}/${path}`)
		.filter((path) => /\.(?:[cm]?[jt]s|jsx|tsx)$/.test(path) && !path.endsWith('.d.ts'));
}

function buildEngine(repositoryRoot: string, repository: V6Repository): GuesslessEngineType {
	const engine = new GuesslessEngine();
	for (const path of sourceFiles(repositoryRoot, repository.sourceDirectory)) {
		const absolute = join(repositoryRoot, path);
		assertContained(repositoryRoot, absolute);
		const added = engine.addFile(path, readFileSync(absolute, 'utf8'));
		if (
			typeof added === 'object' &&
			'schema' in added &&
			added.schema === 'guessless.receipt/v1'
		)
			throw new Error(`production engine rejected '${repository.id}/${path}'`);
	}
	engine.link();
	return engine;
}

function nodeSpan(
	engine: GuesslessEngineType,
	anchor: SymbolAnchor,
): { start: number; end: number; type: string } {
	const resolved = engine.resolve(anchor) as {
		declarations?: readonly { start: number; end: number; type: string }[];
		start?: number;
		end?: number;
		type?: string;
	} | null;
	if (resolved === null) throw new Error(`source adjudication cannot resolve ${anchor.file}`);
	const node = resolved.declarations?.[0] ?? resolved;
	if (
		typeof node.start !== 'number' ||
		typeof node.end !== 'number' ||
		typeof node.type !== 'string'
	)
		throw new Error(`source adjudication lacks exact span for ${anchor.file}`);
	return { start: node.start, end: node.end, type: node.type };
}

function locate(
	engine: GuesslessEngineType,
	repositoryRoot: string,
	anchor: SymbolAnchor,
	classification: { roles?: readonly string[]; reason?: string; detail?: string },
): V6TruthSite {
	if (classification.roles !== undefined)
		for (const role of classification.roles)
			if (!(V6_ROLES as readonly string[]).includes(role))
				throw new Error(`open role '${role}'`);
	if (
		classification.reason !== undefined &&
		!(V6_UNRESOLVED_REASONS as readonly string[]).includes(classification.reason)
	)
		throw new Error(`open unresolved reason '${classification.reason}'`);
	const absolute = join(repositoryRoot, anchor.file);
	assertContained(repositoryRoot, absolute);
	const source = readFileSync(absolute, 'utf8');
	const span = nodeSpan(engine, anchor);
	if (span.start < 0 || span.end <= span.start || span.end > source.length)
		throw new Error(`invalid source span for ${anchor.file}`);
	const lexeme = source.slice(span.start, span.end);
	const prefix = source.slice(0, span.start);
	const line = prefix.split('\n').length;
	const lastNewline = prefix.lastIndexOf('\n');
	const column = Buffer.byteLength(prefix.slice(lastNewline + 1), 'utf8') + 1;
	const byteStart = Buffer.byteLength(prefix, 'utf8');
	const byteEnd = byteStart + Buffer.byteLength(lexeme, 'utf8');
	const coordinate = `${anchor.file}:${line}:${column}`;
	const id =
		classification.roles === undefined
			? `${coordinate}#unresolved:${classification.reason}`
			: `${coordinate}#resolved`;
	const classificationText =
		classification.roles === undefined
			? `closed unresolved reason '${classification.reason}'`
			: `ordered roles ${classification.roles.join(', ')}`;
	return {
		id,
		coordinate,
		file: anchor.file,
		line,
		column,
		byteStart,
		byteEnd,
		lexeme,
		lexemeSha256: sha256(lexeme),
		anchors: [anchor],
		...classification,
		rationale: `Direct source adjudication locates ${span.type} at exact UTF-8 bytes [${byteStart},${byteEnd}) and verifies lexeme SHA-256 ${sha256(lexeme)}; ${classificationText}. The production receipt anchor is a separate cross-check.`,
	};
}

type Analyzer = GuesslessEngineType['analyzer'];
type EngineModule = NonNullable<ReturnType<GuesslessEngineType['module']>>;
type EngineNode = Parameters<EngineModule['symbolOf']>[0];
type EngineSymbol = NonNullable<ReturnType<EngineModule['symbolOf']>>;
type ExportRecord = EngineModule['exports'][number];

function within(module: EngineModule, child: EngineNode, ancestor: EngineNode): boolean {
	let current: EngineNode | null = child;
	while (current !== null) {
		if (current === ancestor) return true;
		current = module.parentOf(current);
	}
	return false;
}

function declarationContaining(
	module: EngineModule,
	node: EngineNode,
	prefix: 'Import' | 'Export',
): EngineNode | null {
	let current: EngineNode | null = node;
	while (current !== null) {
		if (current.type.startsWith(prefix)) return current;
		current = module.parentOf(current);
	}
	return null;
}

function importedRecord(module: EngineModule, node: EngineNode) {
	const symbol = module.symbolOf(node) ?? module.referenceOf(node)?.symbol ?? null;
	for (const record of module.imports) {
		if (record.local === symbol) return record;
		if (record.local?.references.some((reference) => reference.node === node)) return record;
	}
	let current: EngineNode | null = node;
	while (current !== null) {
		if (
			current.type === 'MemberExpression' &&
			'object' in current &&
			current.object !== undefined
		) {
			const object = current.object as EngineNode;
			const objectSymbol = module.symbolOf(object) ?? module.referenceOf(object)?.symbol;
			const record = module.imports.find((candidate) => candidate.local === objectSymbol);
			if (record !== undefined) return record;
		}
		current = module.parentOf(current);
	}
	return undefined;
}

function orderedRoles(roles: ReadonlySet<SafeChangeRole>): SafeChangeRole[] {
	return SAFE_CHANGE_ROLES.filter((role) => roles.has(role));
}

function sourceStructuralRoles(
	analyzer: Analyzer,
	site: SymbolAnchor,
	access?: ReferenceResult['access'],
): SafeChangeRole[] {
	const module = analyzer.module(site.file);
	const node = module === undefined ? null : resolveSiteAnchor(analyzer.modules, site);
	const roles = new Set<SafeChangeRole>(['reference']);
	if (access !== undefined) roles.add(access);
	if (module === undefined || node === null) return orderedRoles(roles);
	let current: EngineNode | null = node;
	while (current !== null) {
		if (current.type.startsWith('Import')) roles.add('import');
		if (current.type.startsWith('Export')) roles.add('export');
		const parent = module.parentOf(current);
		if (
			parent !== null &&
			(parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
			'callee' in parent &&
			parent.callee !== undefined &&
			within(module, node, parent.callee as EngineNode)
		)
			roles.add('call');
		if (
			parent?.type === 'TaggedTemplateExpression' &&
			'tag' in parent &&
			parent.tag !== undefined &&
			within(module, node, parent.tag as EngineNode)
		)
			roles.add('call');
		current = parent;
	}
	const imported = importedRecord(module, node);
	if (imported !== undefined) {
		roles.add('import');
		if (imported.isNamespace) roles.add('namespace');
		if (
			imported.local !== null &&
			imported.name !== null &&
			imported.local.name !== imported.name
		)
			roles.add('alias');
	}
	for (const record of module.exports) {
		const nodeExport = declarationContaining(module, node, 'Export');
		const recordExport = declarationContaining(module, record.node, 'Export');
		if (
			within(module, node, record.node) ||
			(nodeExport !== null && nodeExport === recordExport)
		) {
			roles.add('export');
			if (record.specifier !== null) roles.add('barrel');
			if (record.name !== null && record.fromName !== null && record.name !== record.fromName)
				roles.add('alias');
		}
	}
	return orderedRoles(roles);
}

function sourceDeclarationRoles(analyzer: Analyzer, site: SymbolAnchor): SafeChangeRole[] {
	const roles = new Set<SafeChangeRole>(['declaration']);
	const symbol = resolveSymbolAnchor(analyzer.modules, site);
	if (symbol !== null)
		for (const record of symbol.module.exports)
			if (record.local === symbol || record.local?.name === symbol.name) {
				roles.add('export');
				if (record.specifier !== null) roles.add('barrel');
			}
	return orderedRoles(roles);
}

function normalized(analyzer: Analyzer, symbol: EngineSymbol): EngineSymbol {
	return analyzer.definitionOf(symbol)?.symbol ?? symbol;
}

function exportTargets(
	analyzer: Analyzer,
	record: ExportRecord,
	target: EngineSymbol,
	seen = new Set<string>(),
): boolean {
	const key = `${record.module.path}:${record.id}`;
	if (seen.has(key)) return false;
	seen.add(key);
	if (record.local !== null && normalized(analyzer, record.local) === target) return true;
	if (record.resolvedModule === null) return false;
	const routedName = record.fromName ?? record.name;
	if (routedName !== null) {
		const local = record.resolvedModule.resolve(routedName, undefined, 'any');
		if (local !== null && normalized(analyzer, local) === target) return true;
	}
	return record.resolvedModule.exports.some(
		(candidate) =>
			(candidate.isStar || routedName === null || candidate.name === routedName) &&
			exportTargets(analyzer, candidate, target, seen),
	);
}

function independentAdjudication(
	engine: GuesslessEngineType,
	task: V6Task,
	target: SymbolAnchor,
): { results: SafeChangeImpactResult[]; unresolved: UnresolvedSite[] } {
	const definition = engine.definitionOf(target);
	if (definition.state === 'refused' || definition.results[0] === undefined)
		throw new Error(`independent definition failed '${task.id}'`);
	const declaration = definition.results[0];
	const unresolved: UnresolvedSite[] =
		definition.state === 'partial' ? [...definition.unresolved] : [];
	const impacts = new Map<string, SafeChangeImpactResult>();
	const add = (
		site: SymbolAnchor,
		roles: readonly SafeChangeRole[],
		witness: readonly SymbolAnchor[] = [],
	) => {
		const key = canonicalize(site);
		const previous = impacts.get(key);
		const anchors = new Map(
			[...(previous?.witness ?? []), ...witness].map((anchor) => [
				canonicalize(anchor),
				anchor,
			]),
		);
		impacts.set(key, {
			site,
			roles: orderedRoles(new Set([...(previous?.roles ?? []), ...roles])),
			witness: [...anchors.values()],
		});
	};
	add(declaration, sourceDeclarationRoles(engine.analyzer, declaration));
	if (task.intent === 'entry-point') {
		const reach = engine.reachableFrom(declaration) as Receipt<ReachabilityResult>;
		if (reach.state === 'refused')
			throw new Error(`independent reachability failed '${task.id}'`);
		if (reach.state === 'partial') unresolved.push(...reach.unresolved);
		for (const result of reach.results) {
			add(result.symbol, ['witness'], result.witness);
			for (const site of result.witness) add(site, ['witness'], result.witness);
		}
	} else {
		const references = engine.referencesOf(declaration) as Receipt<ReferenceResult>;
		if (references.state === 'refused')
			throw new Error(`independent references failed '${task.id}'`);
		if (references.state === 'partial') unresolved.push(...references.unresolved);
		for (const result of references.results)
			add(result.site, sourceStructuralRoles(engine.analyzer, result.site, result.access));
		const symbol = resolveSymbolAnchor(engine.analyzer.modules, declaration);
		if (symbol === null) throw new Error(`independent declaration disappeared '${task.id}'`);
		const normalizedTarget = normalized(engine.analyzer, symbol);
		for (const module of engine.analyzer.modules.values()) {
			for (const record of module.imports) {
				if (
					record.local === null ||
					normalized(engine.analyzer, record.local) !== normalizedTarget
				)
					continue;
				const roles = new Set<SafeChangeRole>(['reference', 'import']);
				if (record.isNamespace) roles.add('namespace');
				if (record.name !== null && record.local.name !== record.name) roles.add('alias');
				add(anchorSite(module, record.node, 'safe-change-import'), orderedRoles(roles));
			}
			for (const record of module.exports) {
				if (!exportTargets(engine.analyzer, record, normalizedTarget)) continue;
				const roles = new Set<SafeChangeRole>(['reference', 'export']);
				if (record.specifier !== null) roles.add('barrel');
				if (
					record.name !== null &&
					record.fromName !== null &&
					record.name !== record.fromName
				)
					roles.add('alias');
				add(anchorSite(module, record.node, 'safe-change-export'), orderedRoles(roles));
			}
		}
	}
	const uniqueUnresolved = new Map<string, UnresolvedSite>();
	for (const item of unresolved)
		uniqueUnresolved.set(`${canonicalize(item.site)}:${item.reason}`, item);
	return {
		results: [...impacts.values()].sort((left, right) =>
			canonicalize(left.site).localeCompare(canonicalize(right.site)),
		),
		unresolved: [...uniqueUnresolved.values()].sort((left, right) =>
			`${canonicalize(left.site)}:${left.reason}`.localeCompare(
				`${canonicalize(right.site)}:${right.reason}`,
			),
		),
	};
}

function truthFor(
	engine: GuesslessEngineType,
	repositoryRoot: string,
	task: V6Task,
	receipt: Receipt<SafeChangeImpactResult>,
	adjudicated: ReturnType<typeof independentAdjudication>,
): V6TaskTruth {
	if (receipt.state === 'refused') throw new Error(`frozen task '${task.id}' refused`);
	const receiptUnresolved = receipt.state === 'partial' ? receipt.unresolved : [];
	if (
		stableJson(receipt.results) !== stableJson(adjudicated.results) ||
		stableJson(receiptUnresolved) !== stableJson(adjudicated.unresolved)
	)
		throw new Error(`independent/source production parity mismatch '${task.id}'`);
	const resolvedCandidates = adjudicated.results.map((result) =>
		locate(engine, repositoryRoot, result.site, { roles: result.roles }),
	);
	const unresolvedCandidates =
		adjudicated.unresolved.length > 0
			? adjudicated.unresolved.map((item) =>
					locate(engine, repositoryRoot, item.site, {
						reason: item.reason,
						detail: item.detail,
					}),
				)
			: [];
	const canonicalizeSites = (
		sites: readonly V6TruthSite[],
		classification: 'resolved' | 'unresolved',
	) => {
		const canonical = new Map<string, V6TruthSite>();
		for (const site of sites) {
			const existing = canonical.get(site.id);
			if (existing === undefined) {
				canonical.set(site.id, site);
				continue;
			}
			if (
				existing.byteStart !== site.byteStart ||
				existing.byteEnd !== site.byteEnd ||
				existing.lexemeSha256 !== site.lexemeSha256 ||
				existing.reason !== site.reason ||
				existing.detail !== site.detail
			)
				throw new Error(
					`conflicting duplicate ${classification} coordinate ${task.id}/${site.id}`,
				);
			const anchors = new Map(
				[...existing.anchors, ...site.anchors].map((anchor) => [
					canonicalize(anchor),
					anchor,
				]),
			);
			const roles =
				existing.roles === undefined
					? undefined
					: orderedRoles(
							new Set([
								...(existing.roles as SafeChangeRole[]),
								...((site.roles ?? []) as SafeChangeRole[]),
							]),
						);
			canonical.set(site.id, { ...existing, anchors: [...anchors.values()], roles });
		}
		return [...canonical.values()];
	};
	// Reachability and direct-impact traversals can report the same boundary with
	// different provenance anchors. Source truth has one canonical UTF-8 site;
	// collapse only byte- and classification-identical duplicates and fail closed
	// for every conflicting duplicate.
	const resolved = canonicalizeSites(resolvedCandidates, 'resolved');
	const unresolved = canonicalizeSites(unresolvedCandidates, 'unresolved');
	const resolvedIds = new Set(resolved.map((site) => site.id));
	if (unresolved.some((site) => resolvedIds.has(site.id)))
		throw new Error(`resolved/unresolved overlap ${task.id}`);
	return {
		task,
		state: unresolved.length === 0 ? 'complete' : 'partial',
		snapshot: receipt.snapshot,
		resolved,
		unresolved,
		sourceAdjudication:
			'Exact archive UTF-8 bytes plus independently composed definition/reference/reachability and import/export analysis enumerate canonical facts; the production safe-change receipt is retained only as a parity cross-check.',
	};
}

export function computeRepositoryArtifacts(
	repository: V6Repository,
	archivePath: string,
): { artifacts: V6TaskArtifact[]; truth: V6TaskTruth[]; sourceLedger: unknown[] } {
	const temporary = mkdtempSync(join(tmpdir(), `guessless-v6-${repository.id}-`));
	try {
		safeExtract(archivePath, temporary);
		const repositoryRoot = realpathSync(join(temporary, repository.rootDirectory));
		assertContained(temporary, repositoryRoot);
		const license = join(repositoryRoot, repository.licensePath);
		if (sha256(readFileSync(license)) !== repository.licenseSha256)
			throw new Error(`${repository.id} MIT license hash mismatch`);
		if (!/MIT License/i.test(readFileSync(license, 'utf8')))
			throw new Error(`${repository.id} license is not MIT`);
		const engine = buildEngine(repositoryRoot, repository);
		const artifacts: V6TaskArtifact[] = [];
		const truth: V6TaskTruth[] = [];
		for (const task of V6_TASKS.filter((candidate) => candidate.repository === repository.id)) {
			const target = engine.anchor(task.file, task.symbol);
			if (target === null) throw new Error(`missing or ambiguous frozen target '${task.id}'`);
			const produced = engine.safeChangeImpactSummary(engine.snapshot(), task.intent, target);
			if (!verifyReceipt(produced.receipt) || !verifySafeChangeSummary(produced.summary))
				throw new Error(`invalid production artifact '${task.id}'`);
			if (
				produced.summary.proofHandle !== produced.receipt.integrity ||
				produced.summary.snapshot !== produced.receipt.snapshot ||
				produced.summary.state !== produced.receipt.state
			)
				throw new Error(`full/summary semantic binding mismatch '${task.id}'`);
			const adjudicated = independentAdjudication(engine, task, target);
			artifacts.push({ task, full: produced.receipt, summary: produced.summary });
			truth.push(truthFor(engine, repositoryRoot, task, produced.receipt, adjudicated));
		}
		const sourceLedger = sourceFiles(repositoryRoot, repository.sourceDirectory).map(
			(path) => ({
				path,
				bytes: statSync(join(repositoryRoot, path)).size,
				sha256: sha256(readFileSync(join(repositoryRoot, path))),
			}),
		);
		return { artifacts, truth, sourceLedger };
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export function writeCompressedJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, gzipSync(Buffer.from(stableJson(value)), { level: 9 }));
}

export function readCompressedJson(path: string): unknown {
	return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
}

export function copyVerifiedArchives(source: string, fixtureRoot: string): void {
	const archiveRoot = join(fixtureRoot, 'archives');
	mkdirSync(archiveRoot, { recursive: true });
	for (const repository of V6_REPOSITORIES) {
		const from = join(source, repository.archive);
		if (
			statSync(from).size !== repository.archiveBytes ||
			sha256(readFileSync(from)) !== repository.archiveSha256
		)
			throw new Error(`${repository.id} archive mismatch`);
		cpSync(from, join(archiveRoot, repository.archive));
	}
}
