import type { Analyzer, Module, Reference, Scope, Space, Symbol } from 'yuku-analyzer';
import { anchorSite, anchorSymbol, resolveSymbolAnchor } from './anchors.ts';
import {
	makeReceipt,
	type QueryRequest,
	type Receipt,
	type SymbolAnchor,
	type UnresolvedSite,
} from './contracts.ts';
import {
	boundaryDetail,
	boundaryReason,
	suppliedInputIndex,
	unlinkedInputSites,
} from './linking.ts';
import { analyzerSnapshot } from './snapshot.ts';

export interface ReferenceResult {
	readonly site: SymbolAnchor;
	readonly access: 'read' | 'write' | 'read-write';
}
export interface CaptureResult {
	readonly symbol: SymbolAnchor;
	readonly references: readonly SymbolAnchor[];
	readonly isWritten: boolean;
}
export interface ExportResult {
	readonly name: string;
	readonly module: SymbolAnchor;
}

type YukuNode = Parameters<Module['symbolOf']>[0];
type RichNode = YukuNode & {
	type: string;
	operator?: string;
	left?: YukuNode;
	right?: YukuNode;
	object?: YukuNode;
	property?: YukuNode;
	computed?: boolean;
	value?: unknown;
	id?: YukuNode;
	init?: YukuNode;
	expression?: YukuNode;
	expressions?: YukuNode[];
	argument?: YukuNode;
	arguments?: YukuNode[];
	consequent?: YukuNode;
	alternate?: YukuNode;
	key?: YukuNode;
	name?: string;
	properties?: YukuNode[];
	elements?: Array<YukuNode | null>;
	quasi?: YukuNode;
};

const transparentExpressions = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSTypeAssertion',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
]);

function expressionAccess(
	module: Module,
	node: YukuNode,
	fallback: ReferenceResult['access'] = 'read',
): ReferenceResult['access'] {
	let current: YukuNode = node;
	while (true) {
		const parent = module.parentOf(current) as RichNode | null;
		if (parent === null) return fallback;
		if (parent.type === 'UpdateExpression') return 'read-write';
		if (parent.type === 'UnaryExpression' && parent.operator === 'delete') return 'write';
		if (
			parent.type === 'AssignmentExpression' &&
			parent.left !== undefined &&
			isWithin(module, node, parent.left)
		)
			return parent.operator === '=' ? 'write' : 'read-write';
		if (
			(parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
			parent.left !== undefined &&
			isWithin(module, node, parent.left)
		)
			return 'write';
		if (
			[
				'ExpressionStatement',
				'ReturnStatement',
				'CallExpression',
				'FunctionDeclaration',
				'FunctionExpression',
				'ArrowFunctionExpression',
				'Program',
			].includes(parent.type)
		)
			return fallback;
		current = parent;
	}
}

function referenceAccess(reference: Reference): ReferenceResult['access'] {
	return reference.isWrite ? expressionAccess(reference.module, reference.node, 'write') : 'read';
}

function uniqueUnresolved(items: UnresolvedSite[]): UnresolvedSite[] {
	const seen = new Set<string>();
	return items
		.filter((item) => {
			const key = `${item.reason}:${item.site.file}:${item.site.semanticPath.join('\u0000')}:${item.site.fingerprint}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) =>
			`${a.site.file}:${a.site.semanticPath.join('/')}:${a.reason}`.localeCompare(
				`${b.site.file}:${b.site.semanticPath.join('/')}:${b.reason}`,
			),
		);
}

function moduleClosure(seed: Module, direction: 'dependencies' | 'dependents'): Set<Module> {
	const modules = new Set<Module>([seed]);
	const queue = [seed];
	for (const module of queue)
		for (const next of module[direction])
			if (!modules.has(next)) {
				modules.add(next);
				queue.push(next);
			}
	return modules;
}

function baseUnresolved(analyzer: Analyzer, relevant: ReadonlySet<Module>): UnresolvedSite[] {
	const unresolved: UnresolvedSite[] = [];
	const keys = suppliedInputIndex(analyzer);
	for (const module of analyzer.modules.values()) {
		if (!relevant.has(module)) continue;
		for (const [index, diagnostic] of module.diagnostics.entries())
			unresolved.push({
				site: anchorSite(module, undefined, 'parse-diagnostic', index),
				reason: 'unparsed-file',
				detail: diagnostic.message,
			});
		for (const record of module.imports) {
			if (record.resolvedModule !== null) continue;
			const reason = boundaryReason(record.specifier, keys);
			unresolved.push({
				site: anchorSite(module, record.node, 'import-boundary'),
				reason,
				detail: boundaryDetail('import', record.specifier, reason),
			});
		}
		for (const record of module.exports) {
			if (record.specifier === null || record.resolvedModule !== null) continue;
			const reason = boundaryReason(record.specifier, keys);
			unresolved.push({
				site: anchorSite(module, record.node, 'export-boundary'),
				reason,
				detail: boundaryDetail('export', record.specifier, reason),
			});
		}
	}
	for (const [index, diagnostic] of analyzer.diagnostics.entries()) {
		const module = analyzer.module(diagnostic.module);
		if (module === undefined || !relevant.has(module)) continue;
		unresolved.push({
			site: anchorSite(module, undefined, 'link-diagnostic', index),
			reason: diagnostic.message.includes('ambiguous')
				? 'ambiguous-definition'
				: 'unresolved-symbol',
			detail: diagnostic.message,
		});
	}
	return unresolved;
}

function namespaceEvidence(
	analyzer: Analyzer,
	origin: Symbol,
): { results: ReferenceResult[]; unresolved: UnresolvedSite[] } {
	const results: ReferenceResult[] = [];
	const unresolved: UnresolvedSite[] = [];
	for (const module of analyzer.modules.values())
		for (const record of module.imports) {
			if (!record.isNamespace || record.local === null || record.resolvedModule === null)
				continue;
			for (const reference of record.local.references) {
				const member = module.parentOf(reference.node) as RichNode | null;
				if (member?.type !== 'MemberExpression' || member.object !== reference.node)
					continue;
				const property = member.property as RichNode;
				const key = staticMemberKey(member);
				if (key !== null) {
					const routes = resolvedSymbolPaths(
						analyzer,
						record.resolvedModule,
						String(key),
						origin,
					);
					for (const route of routes) {
						let current = member;
						let remaining = route;
						while (remaining.length > 0) {
							const parent = module.parentOf(current) as RichNode | null;
							if (parent?.type !== 'MemberExpression' || parent.object !== current)
								break;
							const nextKey = staticMemberKey(parent);
							if (nextKey === null || nextKey !== remaining[0]) break;
							current = parent;
							remaining = remaining.slice(1);
						}
						if (remaining.length > 0) continue;
						const finalProperty = (current as RichNode).property as
							| YukuNode
							| undefined;
						results.push({
							site: anchorSite(module, finalProperty ?? property, 'namespace-member'),
							access: expressionAccess(module, current),
						});
					}
					if (routes.length > 0) continue;
				}
				if (
					key !== null ||
					exportedSymbolPaths(analyzer, record.resolvedModule, origin).length === 0
				)
					continue;
				const reason =
					property.type === 'Literal' && typeof property.value === 'string'
						? 'string-keyed-lookup'
						: property.type === 'Identifier'
							? 'dynamic-member-access'
							: 'computed-property-key';
				unresolved.push({
					site: anchorSite(module, member, 'computed-member'),
					reason,
					detail: `Computed member may name '${origin.name}', but binding evidence cannot prove it.`,
				});
			}
		}
	return { results, unresolved };
}

type FlowSegment = string | number | '*';
type FlowPath = readonly FlowSegment[];
type AliasFlow = { symbol: Symbol; paths: readonly FlowPath[] };
type ExportRecord = Module['exports'][number];

function concatPaths(left: readonly FlowPath[], right: readonly FlowPath[]): FlowPath[] {
	return uniquePaths(left.flatMap((prefix) => right.map((suffix) => [...prefix, ...suffix])));
}

function resolvedSymbolPaths(
	analyzer: Analyzer,
	module: Module,
	name: string,
	symbol: Symbol,
	seen = new Set<string>(),
): FlowPath[] {
	const seenKey = `${module.path}:${name}:${symbol.module.path}:${symbol.id}`;
	if (seen.has(seenKey)) return [];
	seen.add(seenKey);
	const paths: FlowPath[] = [];
	const direct = module.exports.filter((record) => record.name === name);
	for (const record of direct) {
		if (record.local !== null) {
			const definition = analyzer.definitionOf(record.local)?.symbol;
			if (record.local === symbol || definition === symbol) paths.push([]);
			else {
				const imported = module.imports.find(
					(candidate) => candidate.local === record.local,
				);
				if (
					imported !== undefined &&
					imported.resolvedModule !== null &&
					imported.name !== null
				)
					paths.push(
						...resolvedSymbolPaths(
							analyzer,
							imported.resolvedModule,
							imported.name,
							symbol,
							seen,
						),
					);
			}
		} else if (record.isNamespaceReexport && record.resolvedModule !== null)
			for (const exportedName of record.resolvedModule.exportedNames())
				paths.push(
					...resolvedSymbolPaths(
						analyzer,
						record.resolvedModule,
						exportedName,
						symbol,
						seen,
					).map((path) => [exportedName, ...path]),
				);
		else if (record.resolvedModule !== null && record.fromName !== null)
			paths.push(
				...resolvedSymbolPaths(
					analyzer,
					record.resolvedModule,
					record.fromName,
					symbol,
					seen,
				),
			);
	}
	if (direct.length === 0 && name !== 'default')
		for (const record of module.exports)
			if (record.isStar && record.resolvedModule !== null)
				paths.push(
					...resolvedSymbolPaths(analyzer, record.resolvedModule, name, symbol, seen),
				);
	return uniquePaths(paths);
}

function exportedSymbolPaths(analyzer: Analyzer, module: Module, symbol: Symbol): FlowPath[] {
	return uniquePaths(
		module
			.exportedNames()
			.flatMap((name) =>
				resolvedSymbolPaths(analyzer, module, name, symbol).map((path) => [name, ...path]),
			),
	);
}

function transportedImportEvidence(analyzer: Analyzer, origin: Symbol): ReferenceResult[] {
	const results: ReferenceResult[] = [];
	const cited = new Set<YukuNode>();
	for (const module of analyzer.modules.values())
		for (const imported of module.imports) {
			if (
				imported.isNamespace ||
				imported.local === null ||
				imported.name === null ||
				imported.resolvedModule === null
			)
				continue;
			const routes = resolvedSymbolPaths(
				analyzer,
				imported.resolvedModule,
				imported.name,
				origin,
			).filter((path) => path.length > 0);
			for (const reference of imported.local.references)
				for (const route of routes) {
					let current: YukuNode = reference.node;
					let remaining = route;
					while (remaining.length > 0) {
						const parent = module.parentOf(current) as RichNode | null;
						if (parent?.type !== 'MemberExpression' || parent.object !== current) break;
						const key = staticMemberKey(parent);
						if (key === null || key !== remaining[0]) break;
						current = parent;
						remaining = remaining.slice(1);
					}
					if (remaining.length > 0 || cited.has(current)) continue;
					cited.add(current);
					const property = (current as RichNode).property as YukuNode | undefined;
					results.push({
						site: anchorSite(module, property ?? current, 'namespace-export-member'),
						access: expressionAccess(module, current),
					});
				}
		}
	return results;
}

function resolvedAnonymousPaths(
	module: Module,
	name: string,
	target: ExportRecord,
	seen = new Set<string>(),
): FlowPath[] {
	const seenKey = `${module.path}:${name}:${target.module.path}:${target.id}`;
	if (seen.has(seenKey)) return [];
	seen.add(seenKey);
	const paths: FlowPath[] = [];
	const direct = module.exports.filter((record) => record.name === name);
	for (const record of direct) {
		if (record.local !== null) {
			const imported = module.imports.find((candidate) => candidate.local === record.local);
			if (
				imported?.resolvedModule !== null &&
				imported?.resolvedModule !== undefined &&
				imported.name !== null
			)
				paths.push(
					...resolvedAnonymousPaths(imported.resolvedModule, imported.name, target, seen),
				);
		} else if (record === target) paths.push([]);
		else if (record.isNamespaceReexport && record.resolvedModule !== null)
			for (const exportedName of record.resolvedModule.exportedNames())
				paths.push(
					...resolvedAnonymousPaths(
						record.resolvedModule,
						exportedName,
						target,
						seen,
					).map((path) => [exportedName, ...path]),
				);
		else if (record.resolvedModule !== null && record.fromName !== null)
			paths.push(
				...resolvedAnonymousPaths(record.resolvedModule, record.fromName, target, seen),
			);
	}
	if (direct.length === 0 && name !== 'default')
		for (const record of module.exports)
			if (record.isStar && record.resolvedModule !== null)
				paths.push(...resolvedAnonymousPaths(record.resolvedModule, name, target, seen));
	return uniquePaths(paths);
}

function queueAnonymousDefaultImports(
	analyzer: Analyzer,
	module: Module,
	exportNode: YukuNode,
	paths: readonly FlowPath[],
	queue: AliasFlow[],
): void {
	const exported = module.exports.find(
		(record) =>
			record.name === 'default' && record.specifier === null && record.node === exportNode,
	);
	if (exported === undefined) return;
	for (const dependent of analyzer.modules.values())
		for (const imported of dependent.imports) {
			if (imported.local === null || imported.resolvedModule === null) continue;
			const routes = imported.isNamespace
				? imported.resolvedModule
						.exportedNames()
						.flatMap((name) =>
							resolvedAnonymousPaths(imported.resolvedModule!, name, exported).map(
								(path) => [name, ...path],
							),
						)
				: imported.name === null
					? []
					: resolvedAnonymousPaths(imported.resolvedModule, imported.name, exported);
			if (routes.length > 0)
				queue.push({ symbol: imported.local, paths: concatPaths(routes, paths) });
		}
}

function queueSymbolImports(analyzer: Analyzer, item: AliasFlow, queue: AliasFlow[]): void {
	for (const module of analyzer.modules.values())
		for (const imported of module.imports) {
			if (imported.local === null || imported.resolvedModule === null) continue;
			const routes = imported.isNamespace
				? exportedSymbolPaths(analyzer, imported.resolvedModule, item.symbol)
				: imported.name === null
					? []
					: resolvedSymbolPaths(
							analyzer,
							imported.resolvedModule,
							imported.name,
							item.symbol,
						);
			const transported = routes.filter((path) =>
				imported.isNamespace ? path.length > 1 : path.length > 0,
			);
			if (transported.length > 0)
				queue.push({
					symbol: imported.local,
					paths: concatPaths(transported, item.paths),
				});
		}
}

function propertyAliasGaps(analyzer: Analyzer, origin: Symbol): UnresolvedSite[] {
	const unresolved: UnresolvedSite[] = [];
	const queue: AliasFlow[] = [{ symbol: origin, paths: [[]] }];
	const seen = new Set<string>();
	for (const item of queue) {
		const paths = uniquePaths(item.paths);
		const key = `${item.symbol.module.path}:${item.symbol.id}:${JSON.stringify(paths)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		queueSymbolImports(analyzer, { symbol: item.symbol, paths }, queue);
		const occurrences: Array<{ module: Module; node: YukuNode; paths: readonly FlowPath[] }> = [
			...analyzer
				.referencesOf(item.symbol)
				.map(({ module, reference }) => ({ module, node: reference.node, paths })),
			...item.symbol.references.map((reference) => ({
				module: item.symbol.module,
				node: reference.node,
				paths,
			})),
		];
		for (const module of analyzer.modules.values())
			for (const record of module.imports) {
				if (!record.isNamespace || record.local === null || record.resolvedModule === null)
					continue;
				const exportedPaths = exportedSymbolPaths(
					analyzer,
					record.resolvedModule,
					item.symbol,
				);
				if (exportedPaths.length === 0) continue;
				for (const reference of record.local.references) {
					const member = module.parentOf(reference.node) as RichNode | null;
					if (member?.type !== 'MemberExpression' || member.object !== reference.node)
						continue;
					const key = staticMemberKey(member);
					if (key === null) {
						if (item.symbol !== origin)
							unresolved.push({
								site: anchorSite(module, member, 'namespace-dynamic-extraction'),
								reason: 'property-alias-write-uncertain',
								detail: `Dynamic namespace extraction may select an aggregate containing '${origin.name}'.`,
							});
						continue;
					}
					const routes = resolvedSymbolPaths(
						analyzer,
						record.resolvedModule,
						String(key),
						item.symbol,
					);
					if (routes.length > 0)
						occurrences.push({
							module,
							node: member,
							paths: concatPaths(routes, paths),
						});
				}
			}
		for (const occurrence of occurrences) {
			const module = occurrence.module;
			let current: YukuNode = occurrence.node;
			let currentPaths = occurrence.paths;
			while (true) {
				const parent = module.parentOf(current) as RichNode | null;
				if (parent === null) break;
				if (
					(transparentExpressions.has(parent.type) ||
						parent.type === 'ChainExpression') &&
					parent.expression === current
				) {
					current = parent;
					continue;
				}
				if (parent.type === 'MemberExpression' && parent.object === current) {
					const direct = currentPaths.some((path) => path.length === 0);
					if (direct) {
						if (memberIsMutated(module, parent))
							unresolved.push(aliasMutationGap(module, parent, item.symbol, origin));
						break;
					}
					const memberKey = staticMemberKey(parent);
					if (memberKey === null) {
						unresolved.push({
							site: anchorSite(module, parent, 'property-alias-write'),
							reason: 'property-alias-write-uncertain',
							detail: `Dynamic extraction from aggregate alias '${item.symbol.name}' may select '${origin.name}'.`,
						});
						break;
					}
					const extracted = pathsAtKey(currentPaths, memberKey);
					if (extracted.length === 0 || memberIsMutated(module, parent)) break;
					current = parent;
					currentPaths = extracted;
					continue;
				}
				if (
					parent.type === 'Property' &&
					parent.value === current &&
					module.parentOf(parent)?.type === 'ObjectExpression'
				) {
					currentPaths = prependPath(currentPaths, staticPropertyKey(parent) ?? '*');
					current = parent;
					continue;
				}
				if (parent.type === 'SpreadElement' && parent.argument === current) {
					current = parent;
					continue;
				}
				if (parent.type === 'ObjectExpression') {
					if (
						current.type === 'SpreadElement' &&
						currentPaths.some((path) => path.length === 0)
					)
						currentPaths = [['*']];
					current = parent;
					continue;
				}
				if (parent.type === 'ArrayExpression') {
					currentPaths = arrayElementPaths(parent, current, currentPaths);
					current = parent;
					continue;
				}
				if (
					parent.type === 'VariableDeclarator' &&
					parent.init === current &&
					parent.id !== undefined
				) {
					queuePatternBindings(
						module,
						parent.id,
						currentPaths,
						queue,
						unresolved,
						origin,
					);
					break;
				}
				if (
					parent.type === 'AssignmentPattern' &&
					parent.right === current &&
					parent.left !== undefined
				) {
					queuePatternBindings(
						module,
						parent.left,
						currentPaths,
						queue,
						unresolved,
						origin,
					);
					break;
				}
				if (
					parent.type === 'AssignmentExpression' &&
					parent.right === current &&
					parent.left !== undefined
				) {
					queuePatternBindings(
						module,
						parent.left,
						currentPaths,
						queue,
						unresolved,
						origin,
					);
					current = parent;
					continue;
				}
				if (
					parent.type === 'SequenceExpression' &&
					parent.expressions?.at(-1) === current
				) {
					current = parent;
					continue;
				}
				if (
					(parent.type === 'LogicalExpression' &&
						(parent.left === current || parent.right === current)) ||
					(parent.type === 'ConditionalExpression' &&
						(parent.consequent === current || parent.alternate === current)) ||
					(parent.type === 'AwaitExpression' && parent.argument === current)
				) {
					current = parent;
					continue;
				}
				if (
					(parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
					parent.arguments?.includes(current)
				) {
					current = parent;
					currentPaths = [[]];
					continue;
				}
				if (
					parent.type === 'TemplateLiteral' &&
					parent.expressions?.includes(current) &&
					(module.parentOf(parent) as RichNode | null)?.type ===
						'TaggedTemplateExpression'
				) {
					current = parent;
					continue;
				}
				if (parent.type === 'TaggedTemplateExpression' && parent.quasi === current) {
					current = parent;
					currentPaths = [[]];
					continue;
				}
				if (parent.type === 'ExportDefaultDeclaration') {
					queueAnonymousDefaultImports(analyzer, module, parent, currentPaths, queue);
					break;
				}
				break;
			}
		}
	}
	return unresolved;
}

function aliasMutationGap(module: Module, node: YukuNode, alias: Symbol, origin: Symbol) {
	return {
		site: anchorSite(module, node, 'property-alias-write'),
		reason: 'property-alias-write-uncertain' as const,
		detail: `Mutation through alias '${alias.name}' cannot be attributed soundly to '${origin.name}'.`,
	};
}

function memberIsMutated(module: Module, member: YukuNode): boolean {
	let current = member;
	let parent = module.parentOf(current) as RichNode | null;
	while (parent?.type === 'ChainExpression' && parent.expression === current) {
		current = parent;
		parent = module.parentOf(current) as RichNode | null;
	}
	if (parent?.type === 'MemberExpression' && parent.object === current) return false;
	return expressionAccess(module, member) !== 'read';
}

function staticMemberKey(member: RichNode): string | number | null {
	const property = member.property as RichNode | undefined;
	if (property === undefined) return null;
	if (!member.computed && property.type === 'Identifier') return property.name ?? null;
	return property.type === 'Literal' &&
		(typeof property.value === 'string' || typeof property.value === 'number')
		? property.value
		: null;
}

function staticPropertyKey(property: RichNode): string | number | null {
	const key = property.key as RichNode | undefined;
	if (key === undefined) return null;
	if (!property.computed && key.type === 'Identifier') return key.name ?? null;
	return key.type === 'Literal' &&
		(typeof key.value === 'string' || typeof key.value === 'number')
		? key.value
		: null;
}

function prependPath(paths: readonly FlowPath[], segment: FlowSegment): FlowPath[] {
	return uniquePaths(paths.map((path) => [segment, ...path]));
}

function pathsAtKey(paths: readonly FlowPath[], key: string | number): FlowPath[] {
	return uniquePaths(
		paths.flatMap((path) => (path[0] === key || path[0] === '*' ? [path.slice(1)] : [])),
	);
}

function arrayElementPaths(
	array: RichNode,
	element: YukuNode,
	paths: readonly FlowPath[],
): FlowPath[] {
	const elements = array.elements ?? [];
	const index = elements.indexOf(element);
	if (index < 0) return [];
	if (element.type !== 'SpreadElement') return prependPath(paths, index);
	if (elements.slice(0, index).some((candidate) => candidate?.type === 'SpreadElement'))
		return [['*']];
	return uniquePaths(
		paths.map((path) =>
			path.length > 0 && typeof path[0] === 'number'
				? [index + path[0], ...path.slice(1)]
				: (['*'] as FlowPath),
		),
	);
}

function queuePatternBindings(
	module: Module,
	pattern: YukuNode,
	paths: readonly FlowPath[],
	queue: AliasFlow[],
	unresolved: UnresolvedSite[],
	origin: Symbol,
): void {
	const node = pattern as RichNode;
	if (node.type === 'Identifier') {
		for (const symbol of bindingSymbols(module, node)) queue.push({ symbol, paths });
		return;
	}
	if (node.type === 'AssignmentPattern' && node.left !== undefined) {
		queuePatternBindings(module, node.left, paths, queue, unresolved, origin);
		return;
	}
	if (node.type === 'RestElement' && node.argument !== undefined) {
		queuePatternBindings(module, node.argument, paths, queue, unresolved, origin);
		return;
	}
	if (paths.some((path) => path[0] === '*')) {
		unresolved.push({
			site: anchorSite(module, pattern, 'aggregate-dynamic-extraction'),
			reason: 'property-alias-write-uncertain',
			detail: `Dynamic aggregate extraction may select '${origin.name}'.`,
		});
		return;
	}
	if (node.type === 'ObjectPattern') {
		const properties = (node.properties ?? []) as RichNode[];
		const excluded = properties
			.filter((property) => property.type === 'Property')
			.map(staticPropertyKey)
			.filter((key): key is string | number => key !== null);
		for (const property of properties) {
			if (property.type === 'Property' && property.value !== undefined) {
				const key = staticPropertyKey(property);
				if (key !== null)
					queuePatternBindings(
						module,
						property.value as YukuNode,
						pathsAtKey(paths, key),
						queue,
						unresolved,
						origin,
					);
				else if (paths.length > 0)
					unresolved.push({
						site: anchorSite(module, property, 'aggregate-dynamic-extraction'),
						reason: 'property-alias-write-uncertain',
						detail: `Dynamic aggregate extraction may select '${origin.name}'.`,
					});
			} else if (property.type === 'RestElement' && property.argument !== undefined)
				queuePatternBindings(
					module,
					property.argument,
					paths.filter((path) => !excluded.includes(path[0] as string | number)),
					queue,
					unresolved,
					origin,
				);
		}
		return;
	}
	if (node.type === 'ArrayPattern')
		for (const [index, element] of (node.elements ?? []).entries()) {
			if (element === null) continue;
			const richElement = element as RichNode;
			const selected =
				richElement.type === 'RestElement'
					? paths
							.filter((path) => typeof path[0] === 'number' && path[0] >= index)
							.map((path) => [Number(path[0]) - index, ...path.slice(1)])
					: pathsAtKey(paths, index);
			queuePatternBindings(module, element, selected, queue, unresolved, origin);
		}
}

function bindingSymbols(module: Module, node: YukuNode): Symbol[] {
	return module.symbols.filter((symbol) =>
		[
			...symbol.declarations,
			...symbol.references
				.filter((reference) => reference.isWrite)
				.map((reference) => reference.node),
		].includes(node),
	);
}

function uniquePaths(paths: readonly FlowPath[]): FlowPath[] {
	const seen = new Set<string>();
	return paths.filter((path) => {
		const key = JSON.stringify(path);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function finish<T>(
	analyzer: Analyzer,
	request: QueryRequest,
	results: T[],
	unresolved: UnresolvedSite[],
): Receipt<T> {
	const sorted = [...results].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const gaps = uniqueUnresolved(unresolved);
	const snapshot = analyzerSnapshot(analyzer);
	const query = request.kind;
	return gaps.length === 0
		? makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query,
				request,
				snapshot,
				results: sorted,
			})
		: makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'partial',
				query,
				request,
				snapshot,
				results: sorted,
				unresolved: gaps,
			});
}

function refuse<T>(
	analyzer: Analyzer,
	request: QueryRequest,
	reason: 'unresolved-symbol' | 'unsupported-syntax',
	detail: string,
): Receipt<T> {
	return makeReceipt({
		schema: 'guessless.receipt/v1',
		state: 'refused',
		query: request.kind,
		request,
		snapshot: analyzerSnapshot(analyzer),
		results: [],
		reason,
		detail,
	});
}

function resolveOrRefuse(
	analyzer: Analyzer,
	request: QueryRequest,
	anchor: SymbolAnchor,
): Symbol | Receipt<never> {
	return (
		resolveSymbolAnchor(analyzer.modules, anchor) ??
		refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'The anchor is missing, changed, deleted, or ambiguous; resolution fails closed.',
		)
	);
}

export function definitionOf(analyzer: Analyzer, anchor: SymbolAnchor): Receipt<SymbolAnchor> {
	const request = { kind: 'definitionOf', target: anchor } as const;
	const symbol = resolveOrRefuse(analyzer, request, anchor);
	if (!('module' in symbol)) return symbol;
	const definition = analyzer.definitionOf(symbol);
	const relevant = moduleClosure(symbol.module, 'dependencies');
	if (definition?.symbol === null || definition === null)
		return finish(
			analyzer,
			request,
			[],
			[
				...baseUnresolved(analyzer, relevant),
				{
					site: anchor,
					reason: 'unresolved-symbol',
					detail: 'Yuku could not prove one defining symbol.',
				},
			],
		);
	return finish(
		analyzer,
		request,
		[anchorSymbol(definition.symbol)],
		baseUnresolved(analyzer, relevant),
	);
}

export function referencesOf(
	analyzer: Analyzer,
	anchor: SymbolAnchor,
	mode: 'all' | 'reads' | 'writes' = 'all',
): Receipt<ReferenceResult> {
	const query = mode === 'all' ? 'referencesOf' : mode === 'reads' ? 'readsOf' : 'writesOf';
	const request = { kind: query, target: anchor } as const;
	const symbol = resolveOrRefuse(analyzer, request, anchor);
	if (!('module' in symbol)) return symbol;
	const origin = analyzer.definitionOf(symbol)?.symbol ?? symbol;
	const results = analyzer.referencesOf(origin).map(({ module, reference }) => ({
		site: anchorSite(module, reference.node, 'reference'),
		access: referenceAccess(reference),
	}));
	const namespace = namespaceEvidence(analyzer, origin);
	results.push(...namespace.results);
	results.push(...transportedImportEvidence(analyzer, origin));
	const filtered = results.filter(
		(result) =>
			mode === 'all' ||
			(mode === 'reads' ? result.access !== 'write' : result.access !== 'read'),
	);
	const relevant = moduleClosure(origin.module, 'dependents');
	// A supplied input whose specifiers failed to link never enters the
	// dependents closure, so its reference sites are invisible to the walk
	// above. Name every such file: absence from results must never be silent.
	return finish(analyzer, request, filtered, [
		...baseUnresolved(analyzer, relevant),
		...unlinkedInputSites(analyzer, relevant),
		...namespace.unresolved,
		...propertyAliasGaps(analyzer, origin),
	]);
}

export function exportedNames(module: Module): Receipt<ExportResult> {
	const relevant = moduleClosure(module, 'dependencies');
	return finish(
		module.analyzer,
		{ kind: 'exportedNames', file: module.path },
		module
			.exportedNames()
			.map((name) => ({ name, module: anchorSite(module, undefined, 'exports') })),
		baseUnresolved(module.analyzer, relevant),
	);
}

function functionNode(symbol: Symbol): YukuNode | undefined {
	for (const declaration of symbol.declarations) {
		const parent = symbol.module.parentOf(declaration) as RichNode | null;
		if (parent !== null && ['FunctionDeclaration', 'FunctionExpression'].includes(parent.type))
			return parent;
		if (
			parent?.type === 'VariableDeclarator' &&
			parent.init !== undefined &&
			['FunctionExpression', 'ArrowFunctionExpression'].includes(parent.init.type)
		)
			return parent.init;
	}
	return undefined;
}

function isWithin(module: Module, child: YukuNode, ancestor: YukuNode): boolean {
	let current: YukuNode | null = child;
	while (current !== null) {
		if (current === ancestor) return true;
		current = module.parentOf(current);
	}
	return false;
}

export function capturesOf(analyzer: Analyzer, anchor: SymbolAnchor): Receipt<CaptureResult> {
	const request = { kind: 'capturesOf', target: anchor } as const;
	const symbol = resolveOrRefuse(analyzer, request, anchor);
	if (!('module' in symbol)) return symbol;
	const node = functionNode(symbol);
	if (node === undefined)
		return refuse(
			analyzer,
			request,
			'unsupported-syntax',
			'The anchored symbol is not backed by a function node.',
		);
	const results = symbol.module.capturesOf(node).map((capture) => ({
		symbol: anchorSymbol(capture.symbol),
		references: capture.references.map((reference) =>
			anchorSite(symbol.module, reference.node, 'capture-reference'),
		),
		isWritten: capture.isWritten,
	}));
	const unresolved = baseUnresolved(analyzer, new Set([symbol.module]));
	for (const reference of symbol.module.unresolvedReferences)
		if (isWithin(symbol.module, reference.node, node))
			unresolved.push({
				site: anchorSite(symbol.module, reference.node, 'unresolved-capture'),
				reason: 'unresolved-symbol',
				detail: `Unresolved/global '${reference.name}' is a capture boundary.`,
			});
	return finish(analyzer, request, results, unresolved);
}

export function resolveBinding(
	analyzer: Analyzer,
	module: Module,
	name: string,
	space: Space = 'value',
	from?: Scope,
	scopeAnchor: SymbolAnchor | null = null,
): Receipt<SymbolAnchor> {
	const request = {
		kind: 'resolveBinding',
		file: module.path,
		name,
		space,
		scope: scopeAnchor,
	} as const;
	const symbol = module.resolve(name, from, space);
	if (symbol !== null && symbol.module !== module)
		return refuse(
			analyzer,
			request,
			'unresolved-symbol',
			'The resolved binding belongs to a different module; resolution fails closed.',
		);
	return finish(
		analyzer,
		request,
		symbol === null ? [] : [anchorSymbol(symbol)],
		baseUnresolved(analyzer, new Set([module])),
	);
}
