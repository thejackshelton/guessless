import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
	BUDGETS,
	CODEX_VERSION,
	EVIDENCE_ID,
	MODEL,
	ORDER,
	SYSTEM_INSTRUCTION,
	TASKS,
	V2_EVIDENCE_ID,
	V3_BUDGETS,
	V3_EVIDENCE_ID,
	V4_EVIDENCE_ID,
	V4_ORDER,
	V4_SYSTEM_INSTRUCTION,
	V5_EVIDENCE_ID,
	V5_ORDER,
	V5_TASKS,
	type EvidenceId,
	fileLedger,
	paths,
	sha256,
	sha256File,
	stableJson,
} from './contracts.ts';

const enginePackage: string = '@guessless/engine';
const { GuesslessEngine } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

export interface GroundTruthTask {
	readonly planted: readonly string[];
	readonly unresolved: readonly string[];
	readonly reads?: readonly string[];
	readonly writes?: readonly string[];
}
export type GroundTruth = Readonly<Record<keyof typeof TASKS, GroundTruthTask>>;

export interface Protocol {
	readonly schema:
		| 'guessless.evaluation-protocol/v1'
		| 'guessless.evaluation-protocol/v2'
		| 'guessless.evaluation-protocol/v3'
		| 'guessless.evaluation-protocol/v4'
		| 'guessless.evaluation-protocol/v5';
	readonly evidenceId: EvidenceId;
	readonly model: string;
	readonly codexVersion: string;
	readonly systemInstruction: string;
	readonly budgets: typeof BUDGETS | typeof V3_BUDGETS;
	readonly environment: Record<string, unknown>;
	readonly environmentPolicy: Record<string, unknown>;
	readonly tasks: typeof TASKS | typeof V5_TASKS;
	readonly order: readonly {
		id: string;
		task: keyof typeof TASKS;
		arm: 'control' | 'guessless';
	}[];
	readonly codexFlags: readonly string[];
	readonly scoring: Record<string, unknown>;
	readonly canonicalSiteId: string;
	readonly responseSchemaSha256: string;
	readonly groundTruthSha256: string;
	readonly inputFiles: readonly { path: string; bytes: number; sha256: string }[];
	readonly taskAggregateSha256: Record<string, string>;
	readonly oracleRationaleSha256?: string;
}

const SCORING = {
	sitesMissed: 'planted minus reported',
	falsePositives: 'reported minus planted',
	falseCompleteness: '1 iff status is complete and sitesMissed is nonempty',
	aggregation: 'sum each metric by arm; no judgment',
};
const V3_SCORING = {
	sitesMissed: 'planted minus reported',
	falsePositives: 'reported minus planted',
	falseCompleteness:
		'1 iff status is complete and sitesMissed is nonempty or ground-truth unresolved remains',
	aggregation:
		'18 exact task-round pairs; exact sign tests and deterministic distribution-free median intervals',
	decision:
		'INCONCLUSIVE then ADOPT then DO_NOT_ADOPT else PILOT under the locked T002 numeric thresholds',
};
const V5_SCORING = {
	sitesMissed: 'resolved ground-truth sites minus reportedSiteIds',
	falsePositives: 'reportedSiteIds minus resolved ground-truth sites',
	falseCompleteness:
		'1 iff status is complete and a resolved requested site is missed or any ground-truth unresolved boundary exists',
	aggregation:
		'18 exact task-round pairs; exact sign tests and deterministic distribution-free median intervals',
	decision:
		'INCONCLUSIVE then ADOPT then DO_NOT_ADOPT else PILOT under the locked T002 numeric thresholds',
	fieldSemantics:
		'reportedSiteIds and unresolvedSiteIds are disjoint; all paths begin with the active task directory',
};
const PROTOCOL_KEYS = [
	'budgets',
	'canonicalSiteId',
	'codexFlags',
	'codexVersion',
	'environment',
	'environmentPolicy',
	'evidenceId',
	'groundTruthSha256',
	'inputFiles',
	'model',
	'order',
	'responseSchemaSha256',
	'schema',
	'scoring',
	'systemInstruction',
	'taskAggregateSha256',
	'tasks',
] as const;

export function loadGroundTruth(fixtureRoot: string = paths().fixtureRoot): GroundTruth {
	return validateGroundTruth(
		JSON.parse(readFileSync(join(fixtureRoot, 'ground-truth.json'), 'utf8')),
		basename(fixtureRoot) === V5_EVIDENCE_ID,
	);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return stableJson(Object.keys(value).sort()) === stableJson([...expected].sort());
}

function exactStringSet(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
		throw new Error(`${label} must be a string array`);
	if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
	return [...value].sort();
}

function validateGroundTruth(value: unknown, v5 = false): GroundTruth {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('ground truth must be an object');
	const root = value as Record<string, unknown>;
	if (!exactKeys(root, ['rename', 'delete', 'reach']))
		throw new Error('ground truth task keys mismatch');
	const normalized: Record<string, GroundTruthTask> = {};
	for (const task of Object.keys(TASKS) as (keyof typeof TASKS)[]) {
		const candidate = root[task];
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
			throw new Error(`${task} ground truth must be an object`);
		const record = candidate as Record<string, unknown>;
		const keys =
			task === 'delete'
				? [v5 ? 'resolved' : 'planted', 'reads', 'writes', 'unresolved']
				: [v5 ? 'resolved' : 'planted', 'unresolved'];
		if (!exactKeys(record, keys)) throw new Error(`${task} ground truth keys mismatch`);
		const planted = exactStringSet(
			v5 ? record.resolved : record.planted,
			`${task}.${v5 ? 'resolved' : 'planted'}`,
		);
		const unresolved = exactStringSet(record.unresolved, `${task}.unresolved`);
		if (!v5 && unresolved.some((id) => !planted.includes(id)))
			throw new Error(`${task} unresolved category is outside planted set`);
		if (v5 && unresolved.some((id) => planted.includes(id)))
			throw new Error(`${task} resolved/unresolved truth overlap`);
		if (task === 'delete') {
			const reads = exactStringSet(record.reads, 'delete.reads');
			const writes = exactStringSet(record.writes, 'delete.writes');
			const categories = [...reads, ...writes, ...(v5 ? [] : unresolved)].sort();
			if (
				new Set(categories).size !== categories.length ||
				stableJson(categories) !== stableJson(planted)
			)
				throw new Error('delete category mismatch');
			normalized[task] = { planted, reads, writes, unresolved };
		} else normalized[task] = { planted, unresolved };
	}
	return normalized as GroundTruth;
}

function aggregateHash(inputRoot: string, task: keyof typeof TASKS): string {
	return sha256(stableJson(fileLedger(join(inputRoot, task))));
}

export function validateProtocol(
	protocol: unknown,
	fixtureRoot: string,
	inputRoot: string = join(fixtureRoot, 'input'),
): Protocol {
	if (protocol === null || typeof protocol !== 'object' || Array.isArray(protocol))
		throw new Error('authoritative protocol must be an object');
	const value = protocol as Protocol;
	const evidenceId = basename(fixtureRoot);
	if (
		![EVIDENCE_ID, V2_EVIDENCE_ID, V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(
			evidenceId,
		)
	)
		throw new Error('authoritative evaluation identity mismatch');
	const expectedSchema = `guessless.evaluation-protocol/${
		evidenceId === EVIDENCE_ID
			? 'v1'
			: evidenceId === V2_EVIDENCE_ID
				? 'v2'
				: evidenceId === V3_EVIDENCE_ID
					? 'v3'
					: evidenceId === V4_EVIDENCE_ID
						? 'v4'
						: 'v5'
	}`;
	const repeated = [V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(evidenceId);
	const v5 = evidenceId === V5_EVIDENCE_ID;
	const expectedResponseSchemaSha256 =
		evidenceId === EVIDENCE_ID
			? '045ad581eafe18fa350bf628a7a74094f5e190d9dbcb0d8b5d12feac6a540569'
			: '0f17b96d34ac989198ced68ef9ebe9ba6c70cafa5cf488e2755ccb4a5a3b66f3';
	if (
		stableJson(Object.keys(value).sort()) !==
			stableJson(v5 ? [...PROTOCOL_KEYS, 'oracleRationaleSha256'].sort() : PROTOCOL_KEYS) ||
		value.schema !== expectedSchema ||
		value.evidenceId !== evidenceId ||
		value.model !== MODEL ||
		value.codexVersion !== CODEX_VERSION ||
		value.systemInstruction !==
			(evidenceId === V4_EVIDENCE_ID || v5 ? V4_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION) ||
		stableJson(value.budgets) !== stableJson(repeated ? V3_BUDGETS : BUDGETS) ||
		stableJson(value.tasks) !== stableJson(v5 ? V5_TASKS : TASKS) ||
		stableJson(value.order) !== stableJson(v5 ? V5_ORDER : repeated ? V4_ORDER : ORDER) ||
		stableJson(value.environment) !==
			stableJson({ node: 'v24.15.0', pnpm: '10.33.2', os: 'Darwin-arm64-25.5.0' }) ||
		stableJson(value.environmentPolicy) !==
			stableJson({
				allowlistedNames: ['HOME', 'LANG', 'PATH', 'TMPDIR'],
				fixedValues: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
				hashedValueNames: ['HOME', 'TMPDIR'],
				forbiddenNamePattern: '(?i)(secret|token|key|password|credential|auth|cookie)',
			}) ||
		stableJson(value.scoring) !==
			stableJson(v5 ? V5_SCORING : repeated ? V3_SCORING : SCORING) ||
		value.canonicalSiteId !==
			(v5
				? '<task>/<task-relative-posix-path>:<1-based-line>:<1-based-column> at the locked lexeme start; reported and unresolved fields are disjoint'
				: '<fixture-relative-posix-path>:<1-based-line>:<1-based-column> at the exact queried symbol occurrence start') ||
		stableJson(value.codexFlags) !==
			stableJson([
				'--ephemeral',
				'--ignore-user-config',
				'--ignore-rules',
				'--skip-git-repo-check',
				'--sandbox',
				'read-only',
				'--json',
			]) ||
		value.responseSchemaSha256 !==
			(v5
				? '8e42acaf9806f361d717d31ae1739acb97dcb8cdf2f4092a968728bf45ce9e91'
				: expectedResponseSchemaSha256) ||
		value.responseSchemaSha256 !== sha256File(join(fixtureRoot, 'response.schema.json')) ||
		value.groundTruthSha256 !==
			(v5
				? '137d8170a850410fee154b1be17b05d6761bcb282d0a279c4f58689111478f22'
				: 'a29b993ba82f72f658d6e37c981fbcc65e6da19b5260e085b1016bd160e8ce2d') ||
		value.groundTruthSha256 !== sha256File(join(fixtureRoot, 'ground-truth.json')) ||
		stableJson(value.inputFiles) !== stableJson(fileLedger(inputRoot)) ||
		stableJson(value.taskAggregateSha256) !==
			stableJson({
				delete: aggregateHash(inputRoot, 'delete'),
				reach: aggregateHash(inputRoot, 'reach'),
				rename: aggregateHash(inputRoot, 'rename'),
			}) ||
		stableJson(value.taskAggregateSha256) !==
			stableJson({
				delete: '7f347f023d615d6398184b498d290c67d79e1686319584f6982f9a96c2e63f2d',
				reach: '42f829712441794707c97086cde20b64f1175f5ab2cb5aa981da15144ab20a6d',
				rename: '35c4d2ba925a247c7190a5a58f4a05546fecb9faff32b9c2401cf0e94b9a0a54',
			}) ||
		(v5 &&
			(value.oracleRationaleSha256 !==
				'98f91a25c7a44ed5a8a4d9e04336e3bd8c9b6b21bf0ebf2c51d6128f59ded389' ||
				value.oracleRationaleSha256 !==
					sha256File(join(fixtureRoot, 'oracle-rationale.json'))))
	)
		throw new Error('authoritative evaluation protocol mismatch');
	return value;
}

export function loadProtocol(fixtureRoot: string = paths().fixtureRoot): Protocol {
	return validateProtocol(
		JSON.parse(readFileSync(join(fixtureRoot, 'protocol.json'), 'utf8')),
		fixtureRoot,
	);
}

type Node = { start: number; end: number; type: string; [key: string]: unknown };
type Symbol = { declarations: readonly Node[]; module: Module };
type Module = {
	path: string;
	source: string;
	parentOf(node: Node): Node | null;
	symbolOf(node: Node): (Symbol & { name: string }) | null;
	imports: readonly {
		isNamespace: boolean;
		local: Symbol | null;
		resolvedModule: Module | null;
		node: Node;
	}[];
};

function positionId(task: keyof typeof TASKS, module: Module, node: Node): string {
	if (!Number.isSafeInteger(node.start) || node.start < 0)
		throw new Error('resolved anchor lacks an exact Yuku start');
	const before = module.source.slice(0, node.start).split('\n');
	return `${task}/${module.path}:${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

function resolveNode(
	engine: InstanceType<typeof GuesslessEngine>,
	anchor: unknown,
): { module: Module; node: Node } {
	const resolved = engine.resolve(anchor as never) as Node | Symbol | null;
	if (resolved === null) throw new Error('receipt anchor did not resolve');
	if ('declarations' in resolved) {
		const symbol = resolved as Symbol;
		if (symbol.declarations.length !== 1) throw new Error('receipt symbol is ambiguous');
		return { module: symbol.module, node: symbol.declarations[0]! };
	}
	const file = (anchor as { file: string }).file;
	const module = engine.module(file) as unknown as Module | undefined;
	if (module === undefined) throw new Error('receipt site module missing');
	return { module, node: resolved };
}

function parentUntil(module: Module, node: Node, type: string): Node | null {
	let current: Node | null = node;
	while (current !== null) {
		if (current.type === type) return current;
		current = module.parentOf(current);
	}
	return null;
}

function taskEngine(
	inputRoot: string,
	task: keyof typeof TASKS,
): InstanceType<typeof GuesslessEngine> {
	const engine = new GuesslessEngine();
	for (const file of fileLedger(join(inputRoot, task))) {
		const added = engine.addFile(
			file.path,
			readFileSync(join(inputRoot, task, file.path), 'utf8'),
		);
		if ('schema' in added) throw new Error(`${task}/${file.path} was not accepted`);
	}
	engine.link();
	return engine;
}

function unique(values: readonly string[]): string[] {
	const sorted = [...values].sort();
	if (new Set(sorted).size !== sorted.length) throw new Error('duplicate resolved position ID');
	return sorted;
}

/**
 * The roles a `referencesOf` result can take at a rename-affected site.
 *
 * Every one of these is a place a rename of the queried symbol must rewrite, so
 * the derivation accepts them all and refuses only shapes it cannot classify.
 * It previously asserted that every rename reference was a call, which was the
 * same blind spot the engine closed: import specifiers and cross-module
 * re-export specifiers are reference results now, and a rename that skipped
 * them would leave the program unbuildable.
 */
type RenameRole = 'declaration' | 'import-specifier' | 'reexport-specifier' | 'call' | 'read';

function renameRole(module: Module, node: Node): RenameRole {
	if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier')
		return 'import-specifier';
	if (node.type === 'ExportSpecifier') return 'reexport-specifier';
	if (node.type !== 'Identifier')
		throw new Error(`rename reference has no rename-affected role: ${node.type}`);
	const owner = module.symbolOf(node);
	if (owner !== null && owner.declarations.includes(node)) return 'declaration';
	const parent = module.parentOf(node);
	const callee = parent?.type === 'MemberExpression' && parent.property === node ? parent : node;
	const call = callee === node ? parent : module.parentOf(callee);
	return call?.type === 'CallExpression' && call.callee === callee ? 'call' : 'read';
}

export function deriveGroundTruth(inputRoot: string): GroundTruth {
	const renameEngine = taskEngine(inputRoot, 'rename');
	const renameTarget = renameEngine.anchor('api.ts', 'sendTelemetry');
	if (renameTarget === null) throw new Error('rename target anchor missing or ambiguous');
	const renameReceipt = renameEngine.referencesOf(renameTarget);
	if (!renameEngine.verify(renameReceipt) || renameReceipt.state !== 'complete')
		throw new Error('rename receipt is not verified complete');
	const renameRoles = new Map<string, RenameRole>();
	const rename = unique(
		renameReceipt.results.map((result) => {
			const { module, node } = resolveNode(renameEngine, result.site);
			const id = positionId('rename', module, node);
			const role = renameRole(module, node);
			const labelled = renameRoles.get(id);
			if (labelled !== undefined && labelled !== role)
				throw new Error(`${id} carries conflicting rename roles`);
			renameRoles.set(id, role);
			return id;
		}),
	);
	if (renameRoles.size !== rename.length) throw new Error('rename role labelling is incomplete');

	const deleteEngine = taskEngine(inputRoot, 'delete');
	const deleteTarget = deleteEngine.anchor('state.ts', 'legacyFlag');
	if (deleteTarget === null) throw new Error('delete target anchor missing or ambiguous');
	const deleteReceipt = deleteEngine.referencesOf(deleteTarget);
	if (!deleteEngine.verify(deleteReceipt) || deleteReceipt.state === 'refused')
		throw new Error('delete receipt is not verified');
	const reads: string[] = [];
	const writes: string[] = [];
	for (const result of deleteReceipt.results) {
		const { module, node } = resolveNode(deleteEngine, result.site);
		const id = positionId('delete', module, node);
		if (result.access === 'read' || result.access === 'read-write') reads.push(id);
		if (result.access === 'write' || result.access === 'read-write') writes.push(id);
	}
	const targetSymbol = deleteEngine.resolve(deleteTarget) as unknown as Symbol;
	const unresolved: string[] = [];
	for (const module of deleteEngine.analyzer.modules.values() as Iterable<Module>)
		for (const imported of module.imports)
			if (imported.resolvedModule === targetSymbol.module) {
				let local = imported.local as (Symbol & { name: string }) | null;
				if (local === null && imported.node.type === 'ImportExpression') {
					const declarator = parentUntil(module, imported.node, 'VariableDeclarator');
					const id = declarator?.id as Node | undefined;
					local = id === undefined ? null : module.symbolOf(id);
				}
				if (
					local === null ||
					(!imported.isNamespace && imported.node.type !== 'ImportExpression')
				)
					continue;
				const anchor = deleteEngine.anchor(module.path, local.name);
				if (anchor === null) throw new Error('namespace anchor missing or ambiguous');
				const receipt = deleteEngine.referencesOf(anchor);
				if (!deleteEngine.verify(receipt) || receipt.state === 'refused')
					throw new Error('namespace receipt is not verified');
				for (const result of receipt.results) {
					const resolved = resolveNode(deleteEngine, result.site);
					const member = parentUntil(resolved.module, resolved.node, 'MemberExpression');
					if (member !== null && member.computed === true) {
						const property = member.property as Node | undefined;
						if (property === undefined)
							throw new Error('computed boundary property missing');
						unresolved.push(positionId('delete', resolved.module, property));
					}
				}
			}

	const reachEngine = taskEngine(inputRoot, 'reach');
	const reachTarget = reachEngine.anchor('entry.ts', 'bootstrap');
	if (reachTarget === null) throw new Error('reach target anchor missing or ambiguous');
	const reachReceipt = reachEngine.reachableFrom(reachTarget);
	if (!reachEngine.verify(reachReceipt) || reachReceipt.state === 'refused')
		throw new Error('reach receipt is not verified');
	const reachResults = reachReceipt.results.map((result) => ({
		result,
		...resolveNode(reachEngine, result.symbol),
	}));
	const boundarySymbols = new Set<unknown>();
	const reachUnresolved: string[] = [];
	for (const current of reachResults) {
		for (const witness of current.result.witness) {
			const site = resolveNode(reachEngine, witness);
			if (parentUntil(site.module, site.node, 'ImportExpression') !== null) {
				boundarySymbols.add(current.result.symbol);
				reachUnresolved.push(positionId('reach', site.module, site.node));
				const enclosing = parentUntil(site.module, site.node, 'FunctionDeclaration');
				for (const candidate of reachResults)
					if (enclosing !== null && candidate.node === (enclosing.id as Node | undefined))
						boundarySymbols.add(candidate.result.symbol);
			}
		}
	}
	for (const gap of reachReceipt.state === 'partial' ? reachReceipt.unresolved : []) {
		const site = resolveNode(reachEngine, gap.site);
		reachUnresolved.push(positionId('reach', site.module, site.node));
	}
	const entry = resolveNode(reachEngine, reachTarget);
	const reachable = [
		positionId('reach', entry.module, entry.node),
		...reachResults
			.filter((item) => !boundarySymbols.has(item.result.symbol))
			.map((item) => positionId('reach', item.module, item.node)),
		...reachUnresolved,
	];
	return {
		rename: { planted: rename, unresolved: [] },
		delete: {
			planted: unique([...reads, ...writes, ...unresolved]),
			reads: unique(reads),
			writes: unique(writes),
			unresolved: unique(unresolved),
		},
		reach: { planted: unique(reachable), unresolved: unique(reachUnresolved) },
	};
}

export function proveGroundTruth(
	fixtureRoot: string = paths().fixtureRoot,
): Record<string, unknown> {
	loadProtocol(fixtureRoot);
	const sources = fileLedger(join(fixtureRoot, 'input')).map((file) =>
		readFileSync(join(fixtureRoot, 'input', file.path), 'utf8'),
	);
	if (sources.some((source) => /@site|rename:|delete:|reach:/.test(source)))
		throw new Error('input contains an answer hint');
	if (basename(fixtureRoot) === V5_EVIDENCE_ID) return proveIndependentGroundTruth(fixtureRoot);
	const recordedValue = JSON.parse(readFileSync(join(fixtureRoot, 'ground-truth.json'), 'utf8'));
	const derived = proveReceiptGroundTruth(recordedValue, join(fixtureRoot, 'input'));
	return derived;
}

export function proveIndependentGroundTruth(fixtureRoot: string): GroundTruth {
	if (basename(fixtureRoot) !== V5_EVIDENCE_ID)
		throw new Error('independent oracle is restricted to v5');
	const truth = loadGroundTruth(fixtureRoot);
	const rationale = JSON.parse(
		readFileSync(join(fixtureRoot, 'oracle-rationale.json'), 'utf8'),
	) as Record<string, unknown>;
	if (
		!exactKeys(rationale, [
			'schema',
			'method',
			'forbiddenAuthorities',
			'coordinateRule',
			'sites',
		]) ||
		rationale.schema !== 'guessless.evaluation-independent-oracle/v1' ||
		rationale.method !== 'fixed source bytes and documented lexemes only' ||
		stableJson(rationale.forbiddenAuthorities) !==
			stableJson([
				'GuesslessEngine',
				'any parser',
				'oracle-part-3-v4 outputs',
				'model outcomes',
				'outcome-dependent tuning',
			]) ||
		rationale.coordinateRule !==
			'UTF-8 fixture bytes interpreted as ASCII source; one-based line and one-based code-unit column at the documented lexeme start' ||
		!Array.isArray(rationale.sites)
	)
		throw new Error('independent oracle rationale contract mismatch');
	const expected = new Map<string, 'resolved' | 'unresolved'>();
	for (const task of Object.keys(TASKS) as (keyof typeof TASKS)[]) {
		for (const id of truth[task].planted) expected.set(id, 'resolved');
		for (const id of truth[task].unresolved) expected.set(id, 'unresolved');
	}
	if (rationale.sites.length !== expected.size)
		throw new Error('independent oracle rationale site count mismatch');
	const observed = new Set<string>();
	for (const unknownSite of rationale.sites) {
		if (unknownSite === null || typeof unknownSite !== 'object' || Array.isArray(unknownSite))
			throw new Error('independent oracle rationale site mismatch');
		const site = unknownSite as Record<string, unknown>;
		if (
			!exactKeys(site, [
				'id',
				'field',
				'sourceSha256',
				'line',
				'column',
				'lexeme',
				'lineText',
			]) ||
			typeof site.id !== 'string' ||
			expected.get(site.id) !== site.field ||
			observed.has(site.id) ||
			typeof site.lexeme !== 'string' ||
			site.lexeme.length === 0 ||
			typeof site.lineText !== 'string' ||
			typeof site.sourceSha256 !== 'string' ||
			!Number.isSafeInteger(site.line) ||
			!Number.isSafeInteger(site.column)
		)
			throw new Error('independent oracle rationale site fields mismatch');
		const match = /^(rename|delete|reach)\/(.+):([1-9][0-9]*):([1-9][0-9]*)$/.exec(site.id);
		if (match === null || Number(match[3]) !== site.line || Number(match[4]) !== site.column)
			throw new Error(`${site.id} independent coordinate mismatch`);
		const bytes = readFileSync(join(fixtureRoot, 'input', match[1]!, match[2]!));
		if (bytes.some((byte) => byte > 0x7f) || sha256(bytes) !== site.sourceSha256)
			throw new Error(`${site.id} fixed source bytes mismatch`);
		const line = bytes.toString('utf8').split('\n')[Number(site.line) - 1];
		const offset = Number(site.column) - 1;
		if (
			line !== site.lineText ||
			line.slice(offset, offset + site.lexeme.length) !== site.lexeme ||
			line.indexOf(site.lexeme) !== offset
		)
			throw new Error(`${site.id} locked lexeme mismatch`);
		observed.add(site.id);
	}
	if (observed.size !== expected.size) throw new Error('independent oracle coverage mismatch');
	return truth;
}

export function proveReceiptGroundTruth(recordedValue: unknown, inputRoot: string): GroundTruth {
	const derived = deriveGroundTruth(inputRoot);
	const recorded = validateGroundTruth(recordedValue);
	if (stableJson(derived) !== stableJson(recorded))
		throw new Error('receipt-derived ground truth mismatch');
	return derived;
}
