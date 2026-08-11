import type { Analyzer, Export, Module, Space, Symbol } from 'yuku-analyzer';
import {
	anchorSite,
	anchorSymbol,
	resolveAnchor,
	resolveSiteAnchor,
	resolveSymbolAnchor,
} from './anchors.ts';
import { canonicalize } from './canonicalize.ts';
import {
	makeReceipt,
	SAFE_CHANGE_ROLES,
	type QueryRequest,
	type Receipt,
	type SafeChangeImpactResult,
	type SafeChangeIntent,
	type SafeChangeRole,
	type SafeChangeTarget,
	type SymbolAnchor,
	type UnresolvedReason,
	type UnresolvedSite,
} from './contracts.ts';
import { definitionOf, referencesOf, resolveBinding } from './queries.ts';
import { reachableFrom } from './reachability.ts';
import { analyzerSnapshot } from './snapshot.ts';

type YukuNode = Parameters<Module['symbolOf']>[0];
type RichNode = YukuNode & {
	type: string;
	callee?: YukuNode;
	tag?: YukuNode;
	object?: YukuNode;
};

function isAnchor(target: SafeChangeTarget): target is SymbolAnchor {
	return 'schema' in target;
}

function isWithin(module: Module, child: YukuNode, ancestor: YukuNode): boolean {
	let current: YukuNode | null = child;
	while (current !== null) {
		if (current === ancestor) return true;
		current = module.parentOf(current);
	}
	return false;
}

function enclosingTypes(module: Module, node: YukuNode): Set<string> {
	const types = new Set<string>();
	let current: YukuNode | null = node;
	while (current !== null) {
		types.add(current.type);
		current = module.parentOf(current);
	}
	return types;
}

function enclosingDeclaration(
	module: Module,
	node: YukuNode,
	prefix: 'Import' | 'Export',
): YukuNode | null {
	let current: YukuNode | null = node;
	while (current !== null) {
		if (current.type.startsWith(prefix)) return current;
		current = module.parentOf(current);
	}
	return null;
}

function importRecordForNode(module: Module, node: YukuNode) {
	const symbol = module.symbolOf(node) ?? module.referenceOf(node)?.symbol ?? null;
	for (const record of module.imports) {
		if (record.local === symbol) return record;
		if (record.local?.references.some((reference) => reference.node === node)) return record;
	}
	let current: YukuNode | null = node;
	while (current !== null) {
		const rich = current as RichNode;
		if (rich.type === 'MemberExpression' && rich.object !== undefined) {
			const objectSymbol =
				module.symbolOf(rich.object) ?? module.referenceOf(rich.object)?.symbol;
			const record = module.imports.find((candidate) => candidate.local === objectSymbol);
			if (record !== undefined) return record;
		}
		current = module.parentOf(current);
	}
	return undefined;
}

function structuralRoles(
	analyzer: Analyzer,
	site: SymbolAnchor,
	access?: 'read' | 'write' | 'read-write',
): SafeChangeRole[] {
	const module = analyzer.module(site.file);
	const node = module === undefined ? null : resolveSiteAnchor(analyzer.modules, site);
	const roles = new Set<SafeChangeRole>(['reference']);
	if (access !== undefined) roles.add(access);
	if (module === undefined || node === null) return sortRoles(roles);
	const types = enclosingTypes(module, node);
	if ([...types].some((type) => type.startsWith('Import'))) roles.add('import');
	if ([...types].some((type) => type.startsWith('Export'))) roles.add('export');
	const imported = importRecordForNode(module, node);
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
	for (const record of module.exports)
		if (
			isWithin(module, node, record.node) ||
			(enclosingDeclaration(module, node, 'Export') !== null &&
				enclosingDeclaration(module, node, 'Export') ===
					enclosingDeclaration(module, record.node, 'Export'))
		) {
			roles.add('export');
			if (record.specifier !== null) roles.add('barrel');
			if (record.name !== null && record.fromName !== null && record.name !== record.fromName)
				roles.add('alias');
		}
	let current: YukuNode | null = node;
	while (current !== null) {
		const parent = module.parentOf(current) as RichNode | null;
		if (
			parent !== null &&
			['CallExpression', 'NewExpression'].includes(parent.type) &&
			parent.callee !== undefined &&
			isWithin(module, node, parent.callee)
		)
			roles.add('call');
		if (
			parent?.type === 'TaggedTemplateExpression' &&
			parent.tag !== undefined &&
			isWithin(module, node, parent.tag)
		)
			roles.add('call');
		current = parent;
	}
	return sortRoles(roles);
}

function declarationRoles(analyzer: Analyzer, site: SymbolAnchor): SafeChangeRole[] {
	const roles = new Set<SafeChangeRole>(['declaration']);
	const resolved = resolveSymbolAnchor(analyzer.modules, site);
	if (resolved !== null)
		for (const record of resolved.module.exports)
			if (record.local === resolved || record.local?.name === resolved.name) {
				roles.add('export');
				if (record.specifier !== null) roles.add('barrel');
			}
	return sortRoles(roles);
}

function normalizedSymbol(analyzer: Analyzer, symbol: Symbol): Symbol {
	return analyzer.definitionOf(symbol)?.symbol ?? symbol;
}

function exportTargetsSymbol(
	analyzer: Analyzer,
	record: Export,
	target: Symbol,
	seen = new Set<string>(),
): boolean {
	const key = `${record.module.path}:${record.id}`;
	if (seen.has(key)) return false;
	seen.add(key);
	if (record.local !== null && normalizedSymbol(analyzer, record.local) === target) return true;
	if (record.resolvedModule === null) return false;
	const routedName = record.fromName ?? record.name;
	if (routedName !== null) {
		const local = record.resolvedModule.resolve(routedName, undefined, 'any');
		if (local !== null && normalizedSymbol(analyzer, local) === target) return true;
	}
	return record.resolvedModule.exports.some(
		(candidate) =>
			(candidate.isStar || routedName === null || candidate.name === routedName) &&
			exportTargetsSymbol(analyzer, candidate, target, seen),
	);
}

function exportedSymbols(
	analyzer: Analyzer,
	module: Module,
	name: string,
	seen = new Set<string>(),
): Symbol[] {
	const visitKey = `${module.path}:${name}`;
	if (seen.has(visitKey)) return [];
	seen.add(visitKey);
	const symbols = new Map<string, Symbol>();
	for (const record of module.exports) {
		if (!record.isStar && record.name !== name) continue;
		if (record.local !== null) {
			const symbol = normalizedSymbol(analyzer, record.local);
			symbols.set(`${symbol.module.path}:${symbol.id}`, symbol);
			continue;
		}
		if (record.resolvedModule === null) continue;
		const routedName = record.fromName ?? name;
		for (const symbol of exportedSymbols(analyzer, record.resolvedModule, routedName, seen))
			symbols.set(`${symbol.module.path}:${symbol.id}`, symbol);
	}
	return [...symbols.values()];
}

function addModuleBoundaryImpacts(
	analyzer: Analyzer,
	target: SymbolAnchor,
	impacts: Map<string, SafeChangeImpactResult>,
): void {
	const symbol = resolveSymbolAnchor(analyzer.modules, target);
	if (symbol === null) return;
	const normalized = normalizedSymbol(analyzer, symbol);
	for (const module of analyzer.modules.values()) {
		for (const record of module.imports) {
			if (record.local === null || normalizedSymbol(analyzer, record.local) !== normalized)
				continue;
			const roles: SafeChangeRole[] = ['reference', 'import'];
			if (record.isNamespace) roles.push('namespace');
			if (record.name !== null && record.local.name !== record.name) roles.push('alias');
			addImpact(impacts, anchorSite(module, record.node, 'safe-change-import'), roles);
		}
		for (const record of module.exports) {
			if (!exportTargetsSymbol(analyzer, record, normalized)) continue;
			const roles: SafeChangeRole[] = ['reference', 'export'];
			if (record.specifier !== null) roles.push('barrel');
			if (record.name !== null && record.fromName !== null && record.name !== record.fromName)
				roles.push('alias');
			addImpact(impacts, anchorSite(module, record.node, 'safe-change-export'), roles);
		}
	}
}

function sortRoles(roles: ReadonlySet<SafeChangeRole>): SafeChangeRole[] {
	return SAFE_CHANGE_ROLES.filter((role) => roles.has(role));
}

function uniqueAnchors(anchors: readonly SymbolAnchor[]): SymbolAnchor[] {
	const seen = new Set<string>();
	return anchors.filter((anchor) => {
		const key = canonicalize(anchor);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function uniqueUnresolved(items: readonly UnresolvedSite[]): UnresolvedSite[] {
	const seen = new Set<string>();
	return [...items]
		.filter((item) => {
			const key = `${canonicalize(item.site)}:${item.reason}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) =>
			`${canonicalize(left.site)}:${left.reason}`.localeCompare(
				`${canonicalize(right.site)}:${right.reason}`,
			),
		);
}

function addImpact(
	impacts: Map<string, SafeChangeImpactResult>,
	site: SymbolAnchor,
	roles: readonly SafeChangeRole[],
	witness: readonly SymbolAnchor[] = [],
): void {
	const key = canonicalize(site);
	const previous = impacts.get(key);
	impacts.set(key, {
		site,
		roles: sortRoles(new Set([...(previous?.roles ?? []), ...roles])),
		witness: uniqueAnchors([...(previous?.witness ?? []), ...witness]),
	});
}

function refuse(
	analyzer: Analyzer,
	request: Extract<QueryRequest, { kind: 'safeChangeImpact' }>,
	reason: UnresolvedReason,
	detail: string,
): Receipt<SafeChangeImpactResult> {
	return makeReceipt({
		schema: 'guessless.receipt/v1',
		state: 'refused',
		query: 'safeChangeImpact',
		request,
		snapshot: analyzerSnapshot(analyzer),
		results: [],
		reason,
		detail,
	});
}

function resolvedTarget(
	analyzer: Analyzer,
	request: Extract<QueryRequest, { kind: 'safeChangeImpact' }>,
): { target: SymbolAnchor; unresolved: UnresolvedSite[] } | Receipt<SafeChangeImpactResult> {
	if (isAnchor(request.target)) {
		if (resolveSymbolAnchor(analyzer.modules, request.target) === null)
			return refuse(
				analyzer,
				request,
				'unresolved-symbol',
				'The target anchor is missing, changed, deleted, or ambiguous.',
			);
		return { target: request.target, unresolved: [] };
	}
	const selector = request.target;
	const module = analyzer.module(selector.file);
	if (module === undefined)
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			`Module '${selector.file}' is not in the linked set.`,
		);
	if (selector.from !== undefined && selector.from.file !== selector.file)
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'The selector scope belongs to a different module.',
		);
	const from =
		selector.from === undefined ? null : resolveAnchor(analyzer.modules, selector.from);
	if (selector.from !== undefined && from === null)
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'The selector scope is stale or ambiguous.',
		);
	const scope =
		from === null ? undefined : 'flags' in from ? (from as Symbol).scope : module.scopeOf(from);
	const binding = resolveBinding(
		analyzer,
		module,
		selector.name,
		selector.space as Space,
		scope,
		selector.from ?? null,
	);
	if (binding.state === 'refused')
		return refuse(analyzer, request, binding.reason, binding.detail);
	const target = binding.results[0];
	if (target === undefined) {
		const exported = exportedSymbols(analyzer, module, selector.name);
		if (exported.length > 1)
			return refuse(
				analyzer,
				request,
				'ambiguous-definition',
				`Exported selector '${selector.name}' resolves to multiple definitions.`,
			);
		if (exported.length === 1)
			return {
				target: anchorSymbol(exported[0]!),
				unresolved: binding.state === 'partial' ? [...binding.unresolved] : [],
			};
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'The selector did not resolve one symbol.',
		);
	}
	return {
		target,
		unresolved: binding.state === 'partial' ? [...binding.unresolved] : [],
	};
}

export function safeChangeImpact(
	analyzer: Analyzer,
	snapshot: string,
	intent: SafeChangeIntent,
	target: SafeChangeTarget,
): Receipt<SafeChangeImpactResult> {
	const request = { kind: 'safeChangeImpact', snapshot, intent, target } as const;
	const currentSnapshot = analyzerSnapshot(analyzer);
	if (snapshot !== currentSnapshot)
		return refuse(
			analyzer,
			request,
			'stale-snapshot',
			'Supplied snapshot does not match the currently linked source set.',
		);
	const selected = resolvedTarget(analyzer, request);
	if ('state' in selected) return selected;
	const unresolved = [...selected.unresolved];
	const definition = definitionOf(analyzer, selected.target);
	if (definition.state === 'refused')
		return refuse(analyzer, request, definition.reason, definition.detail);
	if (definition.state === 'partial') unresolved.push(...definition.unresolved);
	const declaration = definition.results[0] ?? selected.target;
	if (resolveSymbolAnchor(analyzer.modules, declaration) === null)
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'No resolvable declaration was proven.',
		);

	const impacts = new Map<string, SafeChangeImpactResult>();
	addImpact(impacts, declaration, declarationRoles(analyzer, declaration));
	if (intent === 'entry-point') {
		const reach = reachableFrom(analyzer, declaration);
		if (reach.state === 'refused') return refuse(analyzer, request, reach.reason, reach.detail);
		if (reach.state === 'partial') unresolved.push(...reach.unresolved);
		for (const result of reach.results) {
			addImpact(impacts, result.symbol, ['witness'], result.witness);
			for (const site of result.witness)
				addImpact(impacts, site, ['witness'], result.witness);
		}
	} else {
		const references = referencesOf(analyzer, declaration);
		if (references.state === 'refused')
			return refuse(analyzer, request, references.reason, references.detail);
		if (references.state === 'partial') unresolved.push(...references.unresolved);
		for (const result of references.results)
			addImpact(impacts, result.site, structuralRoles(analyzer, result.site, result.access));
		addModuleBoundaryImpacts(analyzer, declaration, impacts);
	}
	const results = [...impacts.values()].sort((left, right) =>
		canonicalize(left.site).localeCompare(canonicalize(right.site)),
	);
	const gaps = uniqueUnresolved(unresolved);
	return gaps.length === 0
		? makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'safeChangeImpact',
				request,
				snapshot: currentSnapshot,
				results,
			})
		: makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'partial',
				query: 'safeChangeImpact',
				request,
				snapshot: currentSnapshot,
				results,
				unresolved: gaps,
			});
}
