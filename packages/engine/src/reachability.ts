import { builtinModules } from 'node:module';
import type { Analyzer, Module, Symbol } from 'yuku-analyzer';
import { anchorSite, anchorSymbol, resolveSymbolAnchor } from './anchors.ts';
import {
	makeReceipt,
	type QueryRequest,
	type Receipt,
	type SymbolAnchor,
	type UnresolvedReason,
	type UnresolvedSite,
} from './contracts.ts';
import { analyzerSnapshot } from './snapshot.ts';

export interface ReachabilityResult {
	readonly symbol: SymbolAnchor;
	readonly witness: readonly SymbolAnchor[];
}

type YukuNode = Parameters<Module['symbolOf']>[0];
type RichNode = YukuNode & {
	type: string;
	name?: string;
	callee?: YukuNode;
	arguments?: YukuNode[];
	params?: YukuNode[];
	body?: YukuNode | YukuNode[];
	object?: YukuNode;
	property?: YukuNode;
	key?: YukuNode;
	computed?: boolean;
	optional?: boolean;
	value?: unknown;
	id?: YukuNode;
	init?: YukuNode;
	left?: YukuNode;
	right?: YukuNode;
	argument?: YukuNode;
	expression?: YukuNode;
	tag?: YukuNode;
	quasi?: YukuNode;
	quasis?: YukuNode[];
	expressions?: YukuNode[];
	elements?: Array<YukuNode | null>;
	properties?: YukuNode[];
	declarations?: YukuNode[];
	kind?: string;
	operator?: string;
	static?: boolean;
	superClass?: YukuNode | null;
	handler?: YukuNode | null;
	param?: YukuNode | null;
	block?: YukuNode;
};
type ResolvedValue = { kind: 'symbol'; symbol: Symbol } | { kind: 'namespace'; module: Module };
type Edge = { symbol: Symbol; site: SymbolAnchor };
type Callable = {
	module: Module;
	node: YukuNode;
	symbol: Symbol | null;
	kind: 'function' | 'class';
	ownerClass?: Callable;
	ownerStatic?: boolean;
};
type BoundCallable = {
	callable: Callable;
	site: SymbolAnchor;
	via: readonly SymbolAnchor[];
};
type BoundValue = StaticNode & {
	via: readonly SymbolAnchor[];
	elements?: readonly BoundValue[];
};
type PatternInput = {
	pattern: YukuNode;
	value: BoundValue;
	prefix: readonly SymbolAnchor[];
};
type CallState = {
	callable: Callable;
	witness: readonly SymbolAnchor[];
	bindings: ReadonlyMap<string, BoundCallable>;
	implicitArguments: ReadonlyMap<number, BoundCallable>;
	implicitValues: ReadonlyMap<number, BoundValue>;
	values: ReadonlyMap<string, BoundValue>;
	patterns: readonly PatternInput[];
};
type Invocation = {
	node: RichNode;
	target: YukuNode;
	arguments: ReadonlyArray<{ node: YukuNode; parameterIndex: number | null }>;
	label: string;
	prefix: readonly SymbolAnchor[];
};
type PropertyAccess = {
	node: RichNode;
	receiver: YukuNode;
	receiverModule: Module;
	key: StaticPropertyKey | null;
	boundaryReason?: UnresolvedReason;
	mode: 'get' | 'set';
	value: YukuNode | null;
	prefix: readonly SymbolAnchor[];
};

type StaticPropertyKey = { kind: 'public' | 'private'; name: string };

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
]);
const classTypes = new Set(['ClassDeclaration', 'ClassExpression']);

function symbolKey(symbol: Symbol): string {
	return `${symbol.module.path}:${symbol.id}`;
}

function normalizeSymbol(analyzer: Analyzer, symbol: Symbol): Symbol {
	return analyzer.definitionOf(symbol)?.symbol ?? symbol;
}

function valueSymbol(module: Module, node: YukuNode): Symbol | null {
	const rich = node as RichNode;
	return (
		module.symbolOf(node) ??
		(rich.type === 'JSXIdentifier' && rich.name !== undefined
			? module.resolve(rich.name, module.scopeOf(node), 'value')
			: null)
	);
}

function staticMemberKey(node: RichNode): string | number | null {
	const property = node.property as RichNode | undefined;
	if (property === undefined) return null;
	if (!node.computed && (property.type === 'Identifier' || property.type === 'JSXIdentifier'))
		return property.name ?? null;
	return property.type === 'Literal' &&
		(typeof property.value === 'string' || typeof property.value === 'number')
		? property.value
		: null;
}

const expressionWrappers = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
	'TSNonNullExpression',
]);

type StaticNode = { module: Module; node: YukuNode };

function unwrapExpression(node: YukuNode): YukuNode {
	let current = node;
	while (expressionWrappers.has(current.type)) {
		const expression = (current as RichNode).expression;
		if (expression === undefined) break;
		current = expression;
	}
	return current;
}

function containsNode(module: Module, ancestor: YukuNode, node: YukuNode): boolean {
	let current: YukuNode | null = node;
	while (current !== null) {
		if (current === ancestor) return true;
		current = module.parentOf(current);
	}
	return false;
}

function immutableBindingValue(symbol: Symbol, seen = new Set<string>()): StaticNode | null {
	const key = symbolKey(symbol);
	if (seen.has(key) || symbol.declarations.length !== 1) return null;
	seen.add(key);
	const target = symbol.declarations[0]!;
	let current: YukuNode | null = target;
	while (current !== null) {
		const parent = symbol.module.parentOf(current) as RichNode | null;
		if (parent?.type === 'VariableDeclarator') {
			const declaration = symbol.module.parentOf(parent) as RichNode | null;
			if (
				declaration?.type !== 'VariableDeclaration' ||
				declaration.kind !== 'const' ||
				parent.id === undefined ||
				parent.init === undefined ||
				parent.init === null
			)
				return null;
			return exactPatternValue(symbol.module, parent.id, target, parent.init, seen);
		}
		current = parent;
	}
	return null;
}

function exactSource(module: Module, node: YukuNode, seen: Set<string>): StaticNode | null {
	const unwrapped = unwrapExpression(node);
	const rich = unwrapped as RichNode;
	if (rich.type !== 'Identifier') return { module, node: unwrapped };
	const symbol = valueSymbol(module, unwrapped);
	if (symbol === null || rich.name === 'undefined') return { module, node: unwrapped };
	return immutableBindingValue(symbol, seen);
}

function exactPatternValue(
	module: Module,
	patternNode: YukuNode,
	target: YukuNode,
	sourceNode: YukuNode,
	seen: Set<string>,
): StaticNode | null {
	const pattern = patternNode as RichNode;
	if (pattern.type === 'Identifier')
		return pattern === target ? exactSource(module, sourceNode, seen) : null;
	if (pattern.type === 'AssignmentPattern' && pattern.left !== undefined) {
		if (staticallyUndefined(module, sourceNode, new Set(seen)))
			return pattern.right === undefined
				? null
				: exactPatternValue(module, pattern.left, target, pattern.right, seen);
		const source = unwrapExpression(sourceNode) as RichNode;
		if (
			!['Literal', 'ObjectExpression', 'ArrayExpression', 'NewExpression'].includes(
				source.type,
			)
		)
			return null;
		return exactPatternValue(module, pattern.left, target, sourceNode, seen);
	}
	const source = exactSource(module, sourceNode, seen);
	if (source === null) return null;
	const sourceRich = source.node as RichNode;
	if (pattern.type === 'ArrayPattern') {
		if (sourceRich.type !== 'ArrayExpression') return null;
		const patternElements = pattern.elements ?? [];
		const sourceElements = sourceRich.elements ?? [];
		if (sourceElements.some((element) => element === null)) return null;
		for (const [index, element] of patternElements.entries()) {
			if (element === null || !containsNode(module, element, target)) continue;
			if ((element as RichNode).type === 'RestElement') return null;
			const value = sourceElements[index];
			if (value === null || value === undefined) {
				const elementPattern = element as RichNode;
				return elementPattern.type === 'AssignmentPattern' &&
					elementPattern.left !== undefined &&
					elementPattern.right !== undefined
					? exactPatternValue(
							source.module,
							elementPattern.left,
							target,
							elementPattern.right,
							seen,
						)
					: null;
			}
			return exactPatternValue(source.module, element, target, value, seen);
		}
		return null;
	}
	if (pattern.type !== 'ObjectPattern' || sourceRich.type !== 'ObjectExpression') return null;
	for (const rawProperty of pattern.properties ?? []) {
		const property = rawProperty as RichNode;
		if (!containsNode(module, property, target)) continue;
		if (property.type !== 'Property' || property.computed || property.value === undefined)
			return null;
		const patternKey = staticPropertyKey(module, property.key, false);
		if (patternKey === null) return null;
		const sourceProperty = (sourceRich.properties ?? [])
			.map((candidate) => candidate as RichNode)
			.find((candidate) => {
				if (
					candidate.type !== 'Property' ||
					candidate.computed ||
					candidate.kind !== 'init'
				)
					return false;
				const sourceKey = staticPropertyKey(source.module, candidate.key, false);
				return (
					sourceKey !== null &&
					propertyKeyIdentity(sourceKey) === propertyKeyIdentity(patternKey)
				);
			});
		if (sourceProperty?.value == null) {
			const valuePattern = property.value as RichNode;
			return valuePattern.type === 'AssignmentPattern' &&
				valuePattern.left !== undefined &&
				valuePattern.right !== undefined
				? exactPatternValue(module, valuePattern.left, target, valuePattern.right, seen)
				: null;
		}
		return exactPatternValue(
			source.module,
			property.value,
			target,
			sourceProperty.value as YukuNode,
			seen,
		);
	}
	return null;
}

function staticPrimitive(
	module: Module,
	node: YukuNode,
	seen = new Set<string>(),
): string | number | null {
	const rich = node as RichNode;
	if (
		rich.type === 'Literal' &&
		(typeof rich.value === 'string' || typeof rich.value === 'number')
	)
		return rich.value;
	if (
		rich.type === 'Literal' &&
		(typeof rich.value === 'boolean' || typeof rich.value === 'bigint' || rich.value === null)
	)
		return String(rich.value);
	if (
		rich.type === 'UnaryExpression' &&
		(rich.operator === '+' || rich.operator === '-') &&
		rich.argument !== undefined
	) {
		const value = staticPrimitive(module, rich.argument, seen);
		return typeof value === 'number' ? (rich.operator === '-' ? -value : value) : null;
	}
	if (rich.type === 'TemplateLiteral' && (rich.expressions?.length ?? 0) === 0) {
		const value = (rich.quasis?.[0] as RichNode | undefined)?.value as
			| { cooked?: unknown }
			| undefined;
		return typeof value?.cooked === 'string' ? value.cooked : null;
	}
	if (expressionWrappers.has(rich.type) && rich.expression !== undefined)
		return staticPrimitive(module, rich.expression, seen);
	if (rich.type !== 'Identifier') return null;
	const symbol = valueSymbol(module, node);
	if (symbol === null || seen.has(symbolKey(symbol))) return null;
	const value = immutableBindingValue(symbol, seen);
	return value === null ? null : staticPrimitive(value.module, value.node, seen);
}

function staticPropertyKey(
	module: Module,
	node: YukuNode | undefined,
	computed: boolean,
): StaticPropertyKey | null {
	if (node === undefined) return null;
	const rich = node as RichNode;
	if (!computed && rich.type === 'PrivateIdentifier' && rich.name !== undefined)
		return { kind: 'private', name: rich.name };
	if (!computed && (rich.type === 'Identifier' || rich.type === 'JSXIdentifier'))
		return rich.name === undefined ? null : { kind: 'public', name: rich.name };
	const primitive = staticPrimitive(module, node);
	return primitive === null ? null : { kind: 'public', name: String(primitive) };
}

function propertyKeyIdentity(key: StaticPropertyKey): string {
	return `${key.kind}:${key.name}`;
}

function resolveExportValue(
	analyzer: Analyzer,
	module: Module,
	name: string,
	seen = new Set<string>(),
): ResolvedValue | null {
	const key = `${module.path}:${name}`;
	if (seen.has(key)) return null;
	seen.add(key);
	const values: ResolvedValue[] = [];
	const direct = module.exports.filter((record) => record.name === name);
	for (const record of direct) {
		if (record.local !== null)
			values.push({ kind: 'symbol', symbol: normalizeSymbol(analyzer, record.local) });
		else if (record.isNamespaceReexport && record.resolvedModule !== null)
			values.push({ kind: 'namespace', module: record.resolvedModule });
		else if (record.resolvedModule !== null && record.fromName !== null) {
			const value = resolveExportValue(
				analyzer,
				record.resolvedModule,
				record.fromName,
				seen,
			);
			if (value !== null) values.push(value);
		}
	}
	if (direct.length === 0 && name !== 'default')
		for (const record of module.exports)
			if (record.isStar && record.resolvedModule !== null) {
				const value = resolveExportValue(analyzer, record.resolvedModule, name, seen);
				if (value !== null) values.push(value);
			}
	const identities = new Map<string, ResolvedValue>();
	for (const value of values)
		identities.set(
			value.kind === 'symbol'
				? `symbol:${symbolKey(value.symbol)}`
				: `module:${value.module.path}`,
			value,
		);
	return identities.size === 1 ? [...identities.values()][0] : null;
}

function resolveValue(analyzer: Analyzer, module: Module, node: YukuNode): ResolvedValue | null {
	const rich = node as RichNode;
	if (rich.type === 'Identifier' || rich.type === 'JSXIdentifier') {
		const symbol = valueSymbol(module, node);
		if (symbol === null) return null;
		const imported = module.imports.find((record) => record.local === symbol);
		if (imported?.resolvedModule !== null && imported?.resolvedModule !== undefined) {
			if (imported.isNamespace) return { kind: 'namespace', module: imported.resolvedModule };
			if (imported.name !== null)
				return resolveExportValue(analyzer, imported.resolvedModule, imported.name);
		}
		return { kind: 'symbol', symbol: normalizeSymbol(analyzer, symbol) };
	}
	if (
		(rich.type === 'MemberExpression' || rich.type === 'JSXMemberExpression') &&
		rich.object !== undefined
	) {
		const object = resolveValue(analyzer, module, rich.object);
		const key = staticMemberKey(rich);
		return object?.kind === 'namespace' && key !== null
			? resolveExportValue(analyzer, object.module, String(key))
			: null;
	}
	return null;
}

function staticallyUndefined(module: Module, node: YukuNode, seen = new Set<string>()): boolean {
	const rich = node as RichNode;
	if (rich.type === 'UnaryExpression' && rich.operator === 'void') return true;
	if (rich.type === 'Identifier') {
		const symbol = valueSymbol(module, node);
		if (rich.name === 'undefined' && symbol === null) return true;
		if (symbol === null || rich.name === 'undefined' || seen.has(symbolKey(symbol)))
			return false;
		const value = immutableBindingValue(symbol, seen);
		return value === null ? false : staticallyUndefined(value.module, value.node, seen);
	}
	if (expressionWrappers.has(rich.type) && rich.expression !== undefined)
		return staticallyUndefined(module, rich.expression, seen);
	return false;
}

function functionNode(symbol: Symbol): YukuNode | null {
	for (const declaration of symbol.declarations) {
		const rich = declaration as RichNode;
		if (functionTypes.has(rich.type)) return declaration;
		const parent = symbol.module.parentOf(declaration) as RichNode | null;
		if (parent !== null && functionTypes.has(parent.type) && parent.id === declaration)
			return parent;
		if (parent?.type === 'VariableDeclarator' && parent.id === declaration) {
			const init = parent.init as RichNode | undefined;
			if (init != null && functionTypes.has(init.type)) return init;
		}
	}
	return null;
}

function classNode(symbol: Symbol): YukuNode | null {
	for (const declaration of symbol.declarations) {
		const rich = declaration as RichNode;
		if (classTypes.has(rich.type)) return declaration;
		const parent = symbol.module.parentOf(declaration) as RichNode | null;
		if (parent !== null && classTypes.has(parent.type) && parent.id === declaration)
			return parent;
		if (parent?.type === 'VariableDeclarator' && parent.id === declaration) {
			const init = parent.init as RichNode | undefined;
			if (init != null && classTypes.has(init.type)) return init;
		}
	}
	return null;
}

function variableInitializer(symbol: Symbol): YukuNode | null {
	for (const declaration of symbol.declarations) {
		const parent = symbol.module.parentOf(declaration) as RichNode | null;
		if (parent?.type === 'VariableDeclarator' && parent.id === declaration)
			return parent.init ?? null;
	}
	return null;
}

function declarationRoots(symbol: Symbol): YukuNode[] {
	const roots = new Set<YukuNode>();
	for (const declaration of symbol.declarations) {
		let current = declaration;
		while (true) {
			const parent = symbol.module.parentOf(current) as RichNode | null;
			if (
				parent === null ||
				[
					'VariableDeclarator',
					'FunctionDeclaration',
					'ClassDeclaration',
					'ImportSpecifier',
					'ImportDefaultSpecifier',
					'ImportNamespaceSpecifier',
				].includes(parent.type)
			) {
				roots.add(parent ?? current);
				break;
			}
			current = parent;
		}
	}
	return [...roots];
}

function uniqueGaps(gaps: UnresolvedSite[]): UnresolvedSite[] {
	const seen = new Set<string>();
	return gaps
		.filter((gap) => {
			const key = `${gap.reason}:${JSON.stringify(gap.site)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function boundaryReason(specifier: string): UnresolvedReason {
	return nodeBuiltins.has(specifier)
		? 'builtin-module-boundary'
		: specifier.startsWith('.')
			? 'unresolved-specifier'
			: 'external-module-boundary';
}

function moduleGaps(analyzer: Analyzer, modules: ReadonlySet<Module>): UnresolvedSite[] {
	const gaps: UnresolvedSite[] = [];
	for (const module of modules) {
		for (const [index, diagnostic] of module.diagnostics.entries())
			gaps.push({
				site: anchorSite(module, undefined, 'reachability-parse-diagnostic', index),
				reason: 'unparsed-file',
				detail: diagnostic.message,
			});
		for (const record of module.imports)
			if (record.resolvedModule === null)
				gaps.push({
					site: anchorSite(module, record.node, 'reachability-import-boundary'),
					reason: boundaryReason(record.specifier),
					detail: `Import '${record.specifier}' leaves the linked file set.`,
				});
		for (const record of module.exports)
			if (record.specifier !== null && record.resolvedModule === null)
				gaps.push({
					site: anchorSite(module, record.node, 'reachability-export-boundary'),
					reason: boundaryReason(record.specifier),
					detail: `Export from '${record.specifier}' leaves the linked file set.`,
				});
	}
	for (const [index, diagnostic] of analyzer.diagnostics.entries()) {
		const module = analyzer.module(diagnostic.module);
		if (module === undefined || !modules.has(module)) continue;
		gaps.push({
			site: anchorSite(module, undefined, 'reachability-link-diagnostic', index),
			reason: diagnostic.message.includes('ambiguous')
				? 'ambiguous-definition'
				: 'unresolved-symbol',
			detail: diagnostic.message,
		});
	}
	return gaps;
}

function finish(
	analyzer: Analyzer,
	request: QueryRequest,
	results: ReachabilityResult[],
	gaps: UnresolvedSite[],
): Receipt<ReachabilityResult> {
	const sortedResults = [...results].sort((a, b) =>
		JSON.stringify(a.symbol).localeCompare(JSON.stringify(b.symbol)),
	);
	const unresolved = uniqueGaps(gaps);
	const base = {
		schema: 'guessless.receipt/v1' as const,
		query: request.kind,
		request,
		snapshot: analyzerSnapshot(analyzer),
		results: sortedResults,
	};
	return unresolved.length === 0
		? makeReceipt({ ...base, state: 'complete' })
		: makeReceipt({ ...base, state: 'partial', unresolved });
}

function refuse(
	analyzer: Analyzer,
	request: QueryRequest,
	reason: 'unresolved-symbol' | 'unsupported-syntax',
	detail: string,
): Receipt<ReachabilityResult> {
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

function resolveEntry(
	analyzer: Analyzer,
	request: QueryRequest,
	anchor: SymbolAnchor,
): Symbol | Receipt<ReachabilityResult> {
	const symbol = resolveSymbolAnchor(analyzer.modules, anchor);
	return symbol === null
		? refuse(
				analyzer,
				request,
				'unresolved-symbol',
				'The reachability target is stale or ambiguous.',
			)
		: normalizeSymbol(analyzer, symbol);
}

function dependencyEvidence(
	analyzer: Analyzer,
	symbol: Symbol,
): { edges: Edge[]; gaps: UnresolvedSite[] } {
	const edges: Edge[] = [];
	const gaps: UnresolvedSite[] = [];
	const seenEdges = new Set<string>();
	const addEdge = (target: Symbol, node: YukuNode, label: string) => {
		const normalized = normalizeSymbol(analyzer, target);
		if (normalized === symbol) return;
		const site = anchorSite(symbol.module, node, label);
		const key = `${symbolKey(normalized)}:${JSON.stringify(site)}`;
		if (seenEdges.has(key)) return;
		seenEdges.add(key);
		edges.push({ symbol: normalized, site });
	};
	for (const root of declarationRoots(symbol))
		symbol.module.walk(
			{
				enter(node) {
					const reference = symbol.module.referenceOf(node);
					if (reference?.symbol !== null && reference?.symbol !== undefined)
						addEdge(reference.symbol, node, 'reachable-reference');
					else if (reference !== null && reference.symbol === null)
						gaps.push({
							site: anchorSite(symbol.module, node, 'reachable-unresolved-reference'),
							reason: 'unresolved-symbol',
							detail: `Unresolved reference '${reference.name}' stops symbol traversal.`,
						});
					const rich = node as RichNode;
					if (rich.type === 'MemberExpression') {
						const value = resolveValue(analyzer, symbol.module, node);
						if (value?.kind === 'symbol')
							addEdge(value.symbol, node, 'reachable-member');
						else if (rich.computed && rich.object !== undefined) {
							const object = resolveValue(analyzer, symbol.module, rich.object);
							if (object?.kind === 'namespace')
								gaps.push({
									site: anchorSite(
										symbol.module,
										node,
										'reachable-dynamic-member',
									),
									reason: 'dynamic-member-access',
									detail: 'Computed namespace selection stops symbol traversal.',
								});
						}
					}
				},
			},
			root,
		);
	return {
		edges: edges.sort((a, b) => JSON.stringify(a.site).localeCompare(JSON.stringify(b.site))),
		gaps,
	};
}

export function reachableFrom(
	analyzer: Analyzer,
	anchor: SymbolAnchor,
): Receipt<ReachabilityResult> {
	const request = { kind: 'reachableFrom', target: anchor } as const;
	const entry = resolveEntry(analyzer, request, anchor);
	if (!('module' in entry)) return entry;
	const queue: Array<{ symbol: Symbol; witness: readonly SymbolAnchor[] }> = [
		{ symbol: entry, witness: [] },
	];
	const visited = new Set<string>();
	const modules = new Set<Module>();
	const gaps: UnresolvedSite[] = [];
	const results = new Map<string, ReachabilityResult>();
	for (const current of queue) {
		const key = symbolKey(current.symbol);
		if (visited.has(key)) continue;
		visited.add(key);
		modules.add(current.symbol.module);
		if (current.symbol !== entry)
			results.set(key, { symbol: anchorSymbol(current.symbol), witness: current.witness });
		const evidence = dependencyEvidence(analyzer, current.symbol);
		gaps.push(...evidence.gaps);
		for (const edge of evidence.edges)
			queue.push({ symbol: edge.symbol, witness: [...current.witness, edge.site] });
	}
	gaps.push(...moduleGaps(analyzer, modules));
	return finish(analyzer, request, [...results.values()], gaps);
}

function directlyWithin(module: Module, node: YukuNode, root: YukuNode): boolean {
	let current = module.parentOf(node);
	while (current !== null && current !== root) {
		if (functionTypes.has(current.type)) return false;
		current = module.parentOf(current);
	}
	return current === root;
}

function classMembers(callable: Callable): RichNode[] {
	if (callable.kind !== 'class') return [];
	const body = (callable.node as RichNode).body as RichNode | undefined;
	return Array.isArray(body?.body) ? (body.body as RichNode[]) : [];
}

function constructorFunction(callable: Callable): YukuNode | null {
	const constructor = classMembers(callable).find(
		(member) => member.type === 'MethodDefinition' && member.kind === 'constructor',
	);
	return constructor === undefined ? null : (constructor.value as YukuNode);
}

function invocationArguments(
	arguments_: readonly YukuNode[],
): Array<{ node: YukuNode; parameterIndex: number | null }> {
	let afterSpread = false;
	return arguments_.map((node, index) => {
		if ((node as RichNode).type === 'SpreadElement') afterSpread = true;
		return { node, parameterIndex: afterSpread ? null : index };
	});
}

function invocationsIn(callable: Callable): Invocation[] {
	const { module } = callable;
	const invocations: Invocation[] = [];
	const roots: Array<{
		node: YukuNode;
		prefix: readonly SymbolAnchor[];
		executesFunctionBody: boolean;
	}> = [];
	if (callable.kind === 'function')
		roots.push({ node: callable.node, prefix: [], executesFunctionBody: true });
	else {
		const constructor = constructorFunction(callable);
		if (constructor !== null)
			roots.push({ node: constructor, prefix: [], executesFunctionBody: true });
		for (const member of classMembers(callable))
			if (
				(member.type === 'PropertyDefinition' || member.type === 'AccessorProperty') &&
				!member.static &&
				member.value !== null &&
				member.value !== undefined
			)
				roots.push({
					node: member.value as YukuNode,
					prefix: [anchorSite(module, member, 'instance-field-initializer-edge')],
					executesFunctionBody: false,
				});
	}
	const evidenceRoot = (
		node: YukuNode,
	):
		| {
				node: YukuNode;
				prefix: readonly SymbolAnchor[];
				executesFunctionBody: boolean;
		  }
		| undefined =>
		roots.find(
			(root) =>
				node === root.node ||
				(!functionTypes.has(root.node.type) || root.executesFunctionBody
					? directlyWithin(module, node, root.node)
					: false),
		);
	module.walk(
		{
			CallExpression(node) {
				const root = evidenceRoot(node);
				if (root === undefined) return;
				const call = node as RichNode;
				if (call.callee === undefined) return;
				invocations.push({
					node: call,
					target: call.callee,
					arguments: invocationArguments(call.arguments ?? []),
					label:
						(call.callee as RichNode).type === 'Super'
							? 'base-constructor-edge'
							: call.optional
								? 'optional-call-edge'
								: 'call-edge',
					prefix: root.prefix,
				});
			},
			NewExpression(node) {
				const root = evidenceRoot(node);
				if (root === undefined) return;
				const call = node as RichNode;
				if (call.callee === undefined) return;
				invocations.push({
					node: call,
					target: call.callee,
					arguments: invocationArguments(call.arguments ?? []),
					label: 'constructor-edge',
					prefix: root.prefix,
				});
			},
			TaggedTemplateExpression(node) {
				const root = evidenceRoot(node);
				if (root === undefined) return;
				const tagged = node as RichNode;
				if (tagged.tag === undefined) return;
				const quasi = tagged.quasi as RichNode | undefined;
				invocations.push({
					node: tagged,
					target: tagged.tag,
					arguments: (quasi?.expressions ?? []).map((expression, index) => ({
						node: expression,
						parameterIndex: index + 1,
					})),
					label: 'tagged-template-edge',
					prefix: root.prefix,
				});
			},
			JSXOpeningElement(node) {
				const root = evidenceRoot(node);
				if (root === undefined) return;
				const opening = node as RichNode;
				const name = opening.name as unknown as YukuNode | undefined;
				if (name === undefined) return;
				invocations.push({
					node: opening,
					target: name,
					arguments: [],
					label: 'jsx-component-edge',
					prefix: root.prefix,
				});
			},
		},
		callable.node,
	);
	if (callable.kind === 'class' && constructorFunction(callable) === null) {
		const superClass = (callable.node as RichNode).superClass;
		if (superClass !== null && superClass !== undefined)
			invocations.unshift({
				node: callable.node as RichNode,
				target: superClass,
				arguments: [],
				label: 'implicit-base-constructor-edge',
				prefix: [],
			});
	}
	return invocations;
}

function executionRoots(callable: Callable): Array<{
	node: YukuNode;
	prefix: readonly SymbolAnchor[];
	executesFunctionBody: boolean;
}> {
	if (callable.kind === 'function')
		return [{ node: callable.node, prefix: [], executesFunctionBody: true }];
	const roots: Array<{
		node: YukuNode;
		prefix: readonly SymbolAnchor[];
		executesFunctionBody: boolean;
	}> = [];
	const constructor = constructorFunction(callable);
	if (constructor !== null)
		roots.push({ node: constructor, prefix: [], executesFunctionBody: true });
	for (const member of classMembers(callable))
		if (
			(member.type === 'PropertyDefinition' || member.type === 'AccessorProperty') &&
			!member.static &&
			member.value !== null &&
			member.value !== undefined
		)
			roots.push({
				node: member.value as YukuNode,
				prefix: [anchorSite(callable.module, member, 'instance-field-initializer-edge')],
				executesFunctionBody: false,
			});
	return roots;
}

function rootForNode(
	callable: Callable,
	node: YukuNode,
): { node: YukuNode; prefix: readonly SymbolAnchor[]; executesFunctionBody: boolean } | null {
	for (const root of executionRoots(callable))
		if (
			node === root.node ||
			(!functionTypes.has(root.node.type) || root.executesFunctionBody
				? directlyWithin(callable.module, node, root.node)
				: false)
		)
			return root;
	return null;
}

function propertyAccessesIn(
	callable: Callable,
	patternInputs: readonly PatternInput[] = [],
): PropertyAccess[] {
	const accesses: PropertyAccess[] = [];
	const addBoundary = (
		node: RichNode,
		source: StaticNode,
		prefix: readonly SymbolAnchor[],
		reason: UnresolvedReason,
	): void => {
		accesses.push({
			node,
			receiver: source.node,
			receiverModule: source.module,
			key: null,
			boundaryReason: reason,
			mode: 'get',
			value: null,
			prefix,
		});
	};
	const addPattern = (
		patternNode: YukuNode,
		sourceInput: BoundValue,
		prefix: readonly SymbolAnchor[],
	): void => {
		const pattern = patternNode as RichNode;
		if (pattern.type === 'AssignmentPattern' && pattern.left !== undefined) {
			const value =
				pattern.right !== undefined &&
				staticallyUndefined(sourceInput.module, sourceInput.node)
					? {
							module: callable.module,
							node: pattern.right,
							via: [
								...sourceInput.via,
								anchorSite(
									callable.module,
									pattern.right,
									'pattern-default-value-edge',
								),
							],
						}
					: sourceInput;
			addPattern(pattern.left, value, prefix);
			return;
		}
		if (pattern.type === 'ArrayPattern') {
			const source =
				sourceInput.elements === undefined
					? exactSource(sourceInput.module, sourceInput.node, new Set())
					: sourceInput;
			const sourceNode = source?.node as RichNode | undefined;
			const sourceElements =
				sourceInput.elements ??
				(sourceNode?.type === 'ArrayExpression'
					? (sourceNode.elements ?? []).map((element) =>
							element === null
								? null
								: { module: source!.module, node: element, via: sourceInput.via },
						)
					: null);
			const elements = pattern.elements ?? [];
			if (
				source === null ||
				sourceElements === null ||
				sourceElements.some(
					(element) =>
						element === null || (element.node as RichNode).type === 'SpreadElement',
				)
			) {
				addBoundary(pattern, sourceInput, prefix, 'linked-set-boundary');
				return;
			}
			for (const [index, element] of elements.entries()) {
				if (element === null) continue;
				if ((element as RichNode).type === 'RestElement') {
					const rest = (element as RichNode).argument;
					if (rest === undefined) {
						addBoundary(
							element as RichNode,
							sourceInput,
							prefix,
							'linked-set-boundary',
						);
						continue;
					}
					addPattern(
						rest,
						{
							module: source.module,
							node: source.node,
							via: sourceInput.via,
							elements: sourceElements.slice(index) as BoundValue[],
						},
						prefix,
					);
					continue;
				}
				const value = sourceElements[index];
				if (value === null || value === undefined) {
					const assignment = element as RichNode;
					if (
						assignment.type === 'AssignmentPattern' &&
						assignment.left !== undefined &&
						assignment.right !== undefined
					) {
						addPattern(
							assignment.left,
							{
								module: callable.module,
								node: assignment.right,
								via: [
									...sourceInput.via,
									anchorSite(
										callable.module,
										assignment.right,
										'pattern-default-value-edge',
									),
								],
							},
							prefix,
						);
						continue;
					}
					addBoundary(element as RichNode, source, prefix, 'linked-set-boundary');
					continue;
				}
				addPattern(element, value, prefix);
			}
			return;
		}
		if (pattern.type !== 'ObjectPattern') return;
		const source = exactSource(sourceInput.module, sourceInput.node, new Set());
		const sourceNode = source?.node as RichNode | undefined;
		for (const rawProperty of pattern.properties ?? []) {
			const property = rawProperty as RichNode;
			if (property.type === 'RestElement') {
				addBoundary(property, source ?? sourceInput, prefix, 'dynamic-member-access');
				continue;
			}
			if (property.type !== 'Property' || property.value === undefined) continue;
			const key = staticPropertyKey(
				callable.module,
				property.key,
				Boolean(property.computed),
			);
			if (source !== null && sourceNode?.type === 'ObjectExpression' && key !== null) {
				const sourceProperty = (sourceNode.properties ?? [])
					.map((candidate) => candidate as RichNode)
					.find((candidate) => {
						if (candidate.type !== 'Property') return false;
						const candidateKey = staticPropertyKey(
							source.module,
							candidate.key,
							Boolean(candidate.computed),
						);
						return (
							candidateKey !== null &&
							propertyKeyIdentity(candidateKey) === propertyKeyIdentity(key)
						);
					});
				if (
					sourceProperty?.kind === 'init' &&
					sourceProperty.value !== null &&
					sourceProperty.value !== undefined
				) {
					addPattern(
						property.value,
						{
							module: source.module,
							node: sourceProperty.value as YukuNode,
							via: sourceInput.via,
						},
						prefix,
					);
					continue;
				}
				addBoundary(property, source, prefix, 'linked-set-boundary');
				continue;
			}
			accesses.push({
				node: property,
				receiver: (source ?? sourceInput).node,
				receiverModule: (source ?? sourceInput).module,
				key,
				mode: 'get',
				value: null,
				prefix,
			});
			const valuePattern = property.value as RichNode;
			if (valuePattern.type === 'ObjectPattern' || valuePattern.type === 'ArrayPattern')
				addBoundary(valuePattern, source ?? sourceInput, prefix, 'linked-set-boundary');
		}
	};
	for (const input of patternInputs)
		addPattern(input.pattern, input.value, [...input.prefix, ...input.value.via]);
	callable.module.walk(
		{
			MemberExpression(node) {
				const root = rootForNode(callable, node);
				if (root === null) return;
				const member = node as RichNode;
				const parent = callable.module.parentOf(node) as RichNode | null;
				if (parent?.type === 'UnaryExpression' && parent.operator === 'delete') return;
				if (parent?.type === 'AssignmentExpression' && parent.left === node) {
					if (parent.operator !== '=')
						accesses.push({
							node: member,
							receiver: member.object!,
							receiverModule: callable.module,
							key: staticPropertyKey(
								callable.module,
								member.property,
								Boolean(member.computed),
							),
							mode: 'get',
							value: null,
							prefix: root.prefix,
						});
					accesses.push({
						node: member,
						receiver: member.object!,
						receiverModule: callable.module,
						key: staticPropertyKey(
							callable.module,
							member.property,
							Boolean(member.computed),
						),
						mode: 'set',
						value: parent.right ?? null,
						prefix: root.prefix,
					});
					return;
				}
				if (parent?.type === 'UpdateExpression' && parent.argument === node) {
					const key = staticPropertyKey(
						callable.module,
						member.property,
						Boolean(member.computed),
					);
					accesses.push({
						node: member,
						receiver: member.object!,
						receiverModule: callable.module,
						key,
						mode: 'get',
						value: null,
						prefix: root.prefix,
					});
					accesses.push({
						node: member,
						receiver: member.object!,
						receiverModule: callable.module,
						key,
						mode: 'set',
						value: null,
						prefix: root.prefix,
					});
					return;
				}
				accesses.push({
					node: member,
					receiver: member.object!,
					receiverModule: callable.module,
					key: staticPropertyKey(
						callable.module,
						member.property,
						Boolean(member.computed),
					),
					mode: 'get',
					value: null,
					prefix: root.prefix,
				});
			},
			VariableDeclarator(node) {
				const root = rootForNode(callable, node);
				if (root === null) return;
				const declarator = node as RichNode;
				if (
					!['ObjectPattern', 'ArrayPattern'].includes(
						(declarator.id as RichNode | undefined)?.type ?? '',
					)
				)
					return;
				if (declarator.init === null || declarator.init === undefined) return;
				addPattern(
					declarator.id!,
					{ module: callable.module, node: declarator.init, via: [] },
					root.prefix,
				);
			},
			AssignmentExpression(node) {
				const root = rootForNode(callable, node);
				if (root === null) return;
				const assignment = node as RichNode;
				if (
					!['ObjectPattern', 'ArrayPattern'].includes(
						(assignment.left as RichNode | undefined)?.type ?? '',
					)
				)
					return;
				if (assignment.right === null || assignment.right === undefined) return;
				addPattern(
					assignment.left!,
					{ module: callable.module, node: assignment.right, via: [] },
					root.prefix,
				);
			},
			ForOfStatement(node) {
				const root = rootForNode(callable, node);
				if (root === null) return;
				const loop = node as RichNode;
				const declaration = loop.left as RichNode | undefined;
				const pattern =
					declaration?.type === 'VariableDeclaration'
						? (declaration.declarations?.[0] as RichNode | undefined)?.id
						: loop.left;
				if (pattern === undefined || loop.right === undefined) return;
				const source = exactSource(callable.module, loop.right, new Set());
				const sourceNode = source?.node as RichNode | undefined;
				if (
					source === null ||
					sourceNode?.type !== 'ArrayExpression' ||
					(sourceNode.elements ?? []).some((element) => element === null)
				) {
					addBoundary(
						loop,
						{ module: callable.module, node: loop.right },
						root.prefix,
						'linked-set-boundary',
					);
					return;
				}
				for (const element of sourceNode.elements ?? [])
					if (element !== null)
						addPattern(
							pattern,
							{ module: source.module, node: element, via: [] },
							root.prefix,
						);
			},
			ForInStatement(node) {
				const root = rootForNode(callable, node);
				const loop = node as RichNode;
				if (root === null || loop.right === undefined) return;
				addBoundary(
					loop,
					{ module: callable.module, node: loop.right },
					root.prefix,
					'linked-set-boundary',
				);
			},
			CatchClause(node) {
				const root = rootForNode(callable, node);
				const clause = node as RichNode;
				if (
					root === null ||
					clause.param === null ||
					clause.param === undefined ||
					!['ObjectPattern', 'ArrayPattern'].includes((clause.param as RichNode).type)
				)
					return;
				const statement = callable.module.parentOf(node) as RichNode | null;
				const block =
					statement?.type === 'TryStatement' ? (statement.block as RichNode) : null;
				const body =
					block?.type === 'BlockStatement' && Array.isArray(block.body) ? block.body : [];
				const thrown =
					body.length === 1 && (body[0] as RichNode).type === 'ThrowStatement'
						? ((body[0] as RichNode).argument ?? null)
						: null;
				if (thrown === null) {
					addBoundary(
						clause,
						{ module: callable.module, node },
						root.prefix,
						'linked-set-boundary',
					);
					return;
				}
				addPattern(
					clause.param,
					{
						module: callable.module,
						node: thrown,
						via: [anchorSite(callable.module, body[0]!, 'throw-to-catch-edge')],
					},
					root.prefix,
				);
			},
			SpreadElement(node) {
				const root = rootForNode(callable, node);
				if (root === null) return;
				const spread = node as RichNode;
				const parent = callable.module.parentOf(node) as RichNode | null;
				if (parent?.type !== 'ObjectExpression' || spread.argument === undefined) return;
				accesses.push({
					node: spread,
					receiver: spread.argument,
					receiverModule: callable.module,
					key: null,
					mode: 'get',
					value: null,
					prefix: root.prefix,
				});
			},
		},
		callable.node,
	);
	return accesses;
}

function callableForSymbol(
	analyzer: Analyzer,
	symbol: Symbol,
	seen = new Set<string>(),
): Callable | null {
	const key = symbolKey(symbol);
	if (seen.has(key)) return null;
	seen.add(key);
	const fn = functionNode(symbol);
	if (fn !== null) return { module: symbol.module, node: fn, symbol, kind: 'function' };
	const class_ = classNode(symbol);
	if (class_ !== null) return { module: symbol.module, node: class_, symbol, kind: 'class' };
	const initializer = variableInitializer(symbol);
	if (initializer !== null) {
		const value = resolveValue(analyzer, symbol.module, initializer);
		if (value?.kind === 'symbol') return callableForSymbol(analyzer, value.symbol, seen);
	}
	return null;
}

function boundCallableOf(
	analyzer: Analyzer,
	module: Module,
	node: YukuNode,
	bindings: ReadonlyMap<string, BoundCallable>,
	seen = new Set<string>(),
): { parameter: string; binding: BoundCallable } | null {
	const value = resolveValue(analyzer, module, node);
	if (value?.kind !== 'symbol') return null;
	const key = symbolKey(value.symbol);
	const binding = bindings.get(key);
	if (binding !== undefined) return { parameter: key, binding };
	if (seen.has(key)) return null;
	seen.add(key);
	const initializer = variableInitializer(value.symbol);
	if (initializer !== null)
		return boundCallableOf(analyzer, value.symbol.module, initializer, bindings, seen);
	return null;
}

function callableOf(analyzer: Analyzer, module: Module, node: YukuNode): Callable | null {
	const rich = node as RichNode;
	if (functionTypes.has(rich.type)) return { module, node, symbol: null, kind: 'function' };
	if (classTypes.has(rich.type)) return { module, node, symbol: null, kind: 'class' };
	const value = resolveValue(analyzer, module, node);
	if (value?.kind !== 'symbol') return null;
	return callableForSymbol(analyzer, value.symbol);
}

type ClassReceiver = {
	callable: Callable;
	static: boolean;
	via: readonly SymbolAnchor[];
};

function classReceiver(
	analyzer: Analyzer,
	module: Module,
	node: YukuNode,
	current: Callable,
	values: ReadonlyMap<string, BoundValue> = new Map(),
	seen = new Set<string>(),
): ClassReceiver | null {
	const rich = node as RichNode;
	if (expressionWrappers.has(rich.type) && rich.expression !== undefined)
		return classReceiver(analyzer, module, rich.expression, current, values, seen);
	if (rich.type === 'ThisExpression') {
		const owner = current.kind === 'class' ? current : current.ownerClass;
		return owner === undefined
			? null
			: { callable: owner, static: current.ownerStatic ?? false, via: [] };
	}
	if (rich.type === 'Super') {
		const owner = current.kind === 'class' ? current : current.ownerClass;
		const superClass = owner === undefined ? undefined : (owner.node as RichNode).superClass;
		if (owner === undefined || superClass === null || superClass === undefined) return null;
		const base = callableOf(analyzer, owner.module, superClass);
		return base?.kind === 'class'
			? {
					callable: base,
					static: current.ownerStatic ?? false,
					via: [anchorSite(owner.module, superClass, 'accessor-super-receiver-edge')],
				}
			: null;
	}
	if (rich.type === 'NewExpression' && rich.callee !== undefined) {
		const callable = callableOf(analyzer, module, rich.callee);
		return callable?.kind === 'class'
			? {
					callable,
					static: false,
					via: [anchorSite(module, rich.callee, 'accessor-receiver-construction-edge')],
				}
			: null;
	}
	const value = resolveValue(analyzer, module, node);
	if (value?.kind !== 'symbol') return null;
	const key = symbolKey(value.symbol);
	if (seen.has(key)) return null;
	seen.add(key);
	const bound = values.get(key);
	if (bound !== undefined) {
		const receiver = classReceiver(analyzer, bound.module, bound.node, current, values, seen);
		return receiver === null ? null : { ...receiver, via: [...bound.via, ...receiver.via] };
	}
	const callable = callableForSymbol(analyzer, value.symbol);
	if (callable?.kind === 'class') return { callable, static: true, via: [] };
	const initializer = variableInitializer(value.symbol);
	return initializer === null
		? null
		: classReceiver(analyzer, value.symbol.module, initializer, current, values, seen);
}

function accessorCallable(
	analyzer: Analyzer,
	receiver: ClassReceiver,
	name: StaticPropertyKey,
	mode: 'get' | 'set',
	seen = new Set<string>(),
):
	| { kind: 'found'; callable: Callable; declaration: SymbolAnchor }
	| { kind: 'absent' }
	| { kind: 'unresolved' } {
	const class_ = receiver.callable;
	const key = class_.symbol === null ? callableKey(class_) : symbolKey(class_.symbol);
	if (seen.has(key)) return { kind: 'absent' };
	seen.add(key);
	const candidates = classMembers(class_).filter(
		(candidate) =>
			candidate.type === 'MethodDefinition' &&
			candidate.kind === mode &&
			Boolean(candidate.static) === receiver.static,
	);
	const member = candidates.find((candidate) => {
		const memberKey = staticPropertyKey(
			class_.module,
			candidate.key,
			Boolean(candidate.computed),
		);
		return memberKey !== null && propertyKeyIdentity(memberKey) === propertyKeyIdentity(name);
	});
	if (member !== undefined)
		return {
			kind: 'found',
			callable: {
				module: class_.module,
				node: member.value as YukuNode,
				symbol: null,
				kind: 'function',
				ownerClass: class_,
				ownerStatic: receiver.static,
			},
			declaration: anchorSite(class_.module, member, `accessor-${mode}-declaration`),
		};
	if (
		candidates.some(
			(candidate) =>
				staticPropertyKey(class_.module, candidate.key, Boolean(candidate.computed)) ===
				null,
		)
	)
		return { kind: 'unresolved' };
	const superClass = (class_.node as RichNode).superClass;
	if (superClass === null || superClass === undefined) return { kind: 'absent' };
	const base = callableOf(analyzer, class_.module, superClass);
	return base?.kind === 'class'
		? accessorCallable(
				analyzer,
				{ callable: base, static: receiver.static, via: [] },
				name,
				mode,
				seen,
			)
		: { kind: 'unresolved' };
}

function classMethodCallable(
	analyzer: Analyzer,
	receiver: ClassReceiver,
	name: StaticPropertyKey,
	seen = new Set<string>(),
):
	| { kind: 'found'; callable: Callable; declaration: SymbolAnchor }
	| { kind: 'absent' }
	| { kind: 'unresolved' } {
	const class_ = receiver.callable;
	const identity = class_.symbol === null ? callableKey(class_) : symbolKey(class_.symbol);
	if (seen.has(identity)) return { kind: 'absent' };
	seen.add(identity);
	const candidates = classMembers(class_).filter(
		(candidate) =>
			candidate.type === 'MethodDefinition' &&
			candidate.kind === 'method' &&
			Boolean(candidate.static) === receiver.static,
	);
	const member = candidates.find((candidate) => {
		const key = staticPropertyKey(class_.module, candidate.key, Boolean(candidate.computed));
		return key !== null && propertyKeyIdentity(key) === propertyKeyIdentity(name);
	});
	if (member !== undefined)
		return {
			kind: 'found',
			callable: {
				module: class_.module,
				node: member.value as YukuNode,
				symbol: null,
				kind: 'function',
				ownerClass: class_,
				ownerStatic: receiver.static,
			},
			declaration: anchorSite(class_.module, member, 'class-method-declaration'),
		};
	if (
		candidates.some(
			(candidate) =>
				staticPropertyKey(class_.module, candidate.key, Boolean(candidate.computed)) ===
				null,
		)
	)
		return { kind: 'unresolved' };
	const superClass = (class_.node as RichNode).superClass;
	if (superClass === null || superClass === undefined) return { kind: 'absent' };
	const base = callableOf(analyzer, class_.module, superClass);
	return base?.kind === 'class'
		? classMethodCallable(
				analyzer,
				{ callable: base, static: receiver.static, via: [] },
				name,
				seen,
			)
		: { kind: 'unresolved' };
}

type ParameterEntry = {
	symbol: Symbol | null;
	defaultValue: YukuNode | null;
};

function parameterNodes(callable: Callable): YukuNode[] {
	const function_ = callable.kind === 'class' ? constructorFunction(callable) : callable.node;
	return function_ === null ? [] : ((function_ as RichNode).params ?? []);
}

function parameterBinding(parameter: YukuNode): YukuNode {
	const rich = parameter as RichNode;
	if (rich.type === 'RestElement' && rich.argument !== undefined)
		return parameterBinding(rich.argument);
	if (rich.type === 'AssignmentPattern' && rich.left !== undefined) return rich.left;
	return parameter;
}

function parameterEntries(callable: Callable): ParameterEntry[] {
	return parameterNodes(callable).map((parameter) => {
		const rich = parameter as RichNode;
		if (rich.type === 'RestElement' && rich.argument !== undefined)
			return { symbol: valueSymbol(callable.module, rich.argument), defaultValue: null };
		if (rich.type === 'AssignmentPattern' && rich.left !== undefined)
			return {
				symbol: valueSymbol(callable.module, rich.left),
				defaultValue: rich.right ?? null,
			};
		if (rich.type === 'Identifier')
			return { symbol: valueSymbol(callable.module, parameter), defaultValue: null };
		return { symbol: null, defaultValue: null };
	});
}

function argumentValue(
	module: Module,
	node: YukuNode,
	values: ReadonlyMap<string, BoundValue>,
): BoundValue {
	const symbol = valueSymbol(module, unwrapExpression(node));
	const bound = symbol === null ? undefined : values.get(symbolKey(symbol));
	const site = anchorSite(module, node, 'static-value-binding-edge');
	return bound === undefined
		? { module, node, via: [site] }
		: { ...bound, via: [...bound.via, site] };
}

function bindPatternValues(
	module: Module,
	patternNode: YukuNode,
	value: BoundValue,
	bindings: Map<string, BoundValue>,
): void {
	const pattern = patternNode as RichNode;
	if (pattern.type === 'Identifier') {
		const symbol = valueSymbol(module, patternNode);
		if (symbol !== null) bindings.set(symbolKey(symbol), value);
		return;
	}
	if (pattern.type === 'AssignmentPattern' && pattern.left !== undefined) {
		bindPatternValues(module, pattern.left, value, bindings);
		return;
	}
	const source =
		value.elements === undefined ? exactSource(value.module, value.node, new Set()) : value;
	if (source === null) return;
	const sourceNode = source.node as RichNode;
	if (
		pattern.type === 'ArrayPattern' &&
		(sourceNode.type === 'ArrayExpression' || value.elements !== undefined)
	) {
		const sourceElements =
			value.elements ??
			(sourceNode.elements ?? []).map((element) =>
				element === null ? null : { module: source.module, node: element, via: value.via },
			);
		if (sourceElements.some((element) => element === null)) return;
		for (const [index, element] of (pattern.elements ?? []).entries()) {
			if (element === null) continue;
			if ((element as RichNode).type === 'RestElement') {
				const rest = (element as RichNode).argument;
				if (rest !== undefined)
					bindPatternValues(
						module,
						rest,
						{
							module: source.module,
							node: source.node,
							via: value.via,
							elements: sourceElements.slice(index) as BoundValue[],
						},
						bindings,
					);
				continue;
			}
			const sourceElement = sourceElements[index];
			if (sourceElement === null || sourceElement === undefined) {
				const assignment = element as RichNode;
				if (
					assignment.type === 'AssignmentPattern' &&
					assignment.left !== undefined &&
					assignment.right !== undefined
				)
					bindPatternValues(
						module,
						assignment.left,
						{
							module,
							node: assignment.right,
							via: [
								...value.via,
								anchorSite(module, assignment.right, 'pattern-default-value-edge'),
							],
						},
						bindings,
					);
				continue;
			}
			bindPatternValues(module, element, sourceElement, bindings);
		}
		return;
	}
	if (pattern.type !== 'ObjectPattern' || sourceNode.type !== 'ObjectExpression') return;
	for (const rawProperty of pattern.properties ?? []) {
		const property = rawProperty as RichNode;
		if (property.type !== 'Property' || property.computed || property.value === undefined)
			continue;
		const key = staticPropertyKey(module, property.key, false);
		if (key === null) continue;
		const sourceProperty = (sourceNode.properties ?? [])
			.map((candidate) => candidate as RichNode)
			.find((candidate) => {
				if (candidate.type !== 'Property' || candidate.computed) return false;
				const candidateKey = staticPropertyKey(source.module, candidate.key, false);
				return (
					candidateKey !== null &&
					propertyKeyIdentity(candidateKey) === propertyKeyIdentity(key)
				);
			});
		if (
			sourceProperty?.kind !== 'init' ||
			sourceProperty.value === null ||
			sourceProperty.value === undefined
		)
			continue;
		bindPatternValues(
			module,
			property.value,
			{
				module: source.module,
				node: sourceProperty.value as YukuNode,
				via: value.via,
			},
			bindings,
		);
	}
}

function isWithinNode(module: Module, node: YukuNode, ancestor: YukuNode): boolean {
	let current: YukuNode | null = node;
	while (current !== null) {
		if (current === ancestor) return true;
		current = module.parentOf(current);
	}
	return false;
}

function isParameterBinding(callable: Callable, symbol: Symbol | null): boolean {
	if (symbol === null || symbol.module !== callable.module) return false;
	return symbol.declarations.some((declaration) =>
		parameterNodes(callable).some((parameter) =>
			isWithinNode(callable.module, declaration, parameter),
		),
	);
}

function callableKey(callable: Callable): string {
	return callable.symbol === null
		? `${callable.module.path}:anonymous:${JSON.stringify(
				anchorSite(callable.module, callable.node, 'anonymous-callback'),
			)}`
		: symbolKey(callable.symbol);
}

function invocationBoundary(module: Module, invocation: Invocation): UnresolvedSite {
	const target = invocation.target as RichNode;
	if (invocation.node.type === 'CallExpression' && target.type === 'CallExpression')
		return {
			site: anchorSite(module, invocation.node, 'call-result-boundary'),
			reason: 'higher-order-call-boundary',
			detail: 'Calling an opaque returned value cannot be proven statically.',
		};
	if (target.type === 'MemberExpression' && target.computed)
		return {
			site: anchorSite(module, target, 'computed-callee-boundary'),
			reason:
				staticMemberKey(target) === null
					? 'dynamic-member-access'
					: 'computed-property-key',
			detail: 'Computed callee selection stops executable traversal.',
		};
	if (target.type === 'Identifier' || target.type === 'JSXIdentifier') {
		const symbol = valueSymbol(module, target);
		const imported = module.imports.find((record) => record.local === symbol);
		if (imported !== undefined && imported.resolvedModule === null)
			return {
				site: anchorSite(module, target, 'external-call-boundary'),
				reason: boundaryReason(imported.specifier),
				detail: `Invocation implementation from '${imported.specifier}' is outside the linked set.`,
			};
	}
	return {
		site: anchorSite(
			module,
			target,
			invocation.node.type === 'CallExpression'
				? 'unresolved-call-boundary'
				: 'unresolved-invocation-boundary',
		),
		reason: target.type === 'JSXNamespacedName' ? 'unsupported-syntax' : 'unresolved-symbol',
		detail: `${invocation.node.type} target identity could not be proven.`,
	};
}

function stateKey(state: CallState): string {
	return `${callableKey(state.callable)}:${[...state.bindings]
		.map(([parameter, binding]) => `${parameter}=${callableKey(binding.callable)}`)
		.sort()
		.join(',')}:${[...state.implicitArguments]
		.map(([index, binding]) => `${index}=${callableKey(binding.callable)}`)
		.sort()
		.join(',')}:${[...state.implicitValues]
		.map(
			([index, value]) =>
				`${index}=${JSON.stringify(anchorSite(value.module, value.node, 'static-value-key'))}`,
		)
		.sort()
		.join(',')}:${[...state.values]
		.map(
			([parameter, value]) =>
				`${parameter}=${JSON.stringify(anchorSite(value.module, value.node, 'static-value-key'))}`,
		)
		.sort()
		.join(',')}:${state.patterns
		.map(
			(input) =>
				`${JSON.stringify(anchorSite(state.callable.module, input.pattern, 'pattern-key'))}=${JSON.stringify(anchorSite(input.value.module, input.value.node, 'static-value-key'))}`,
		)
		.sort()
		.join(',')}`;
}

export function reaches(analyzer: Analyzer, anchor: SymbolAnchor): Receipt<ReachabilityResult> {
	const request = { kind: 'reaches', target: anchor } as const;
	const entry = resolveEntry(analyzer, request, anchor);
	if (!('module' in entry)) return entry;
	const root = functionNode(entry);
	if (root === null)
		return refuse(
			analyzer,
			request,
			'unsupported-syntax',
			'The reaches target is not backed by executable function syntax.',
		);
	const queue: CallState[] = [
		{
			callable: {
				module: entry.module,
				node: root,
				symbol: entry,
				kind: 'function',
			},
			witness: [],
			bindings: new Map(),
			implicitArguments: new Map(),
			implicitValues: new Map(),
			values: new Map(),
			patterns: [],
		},
	];
	const visited = new Set<string>();
	const modules = new Set<Module>();
	const results = new Map<string, ReachabilityResult>();
	const gaps: UnresolvedSite[] = [];
	for (const state of queue) {
		const key = stateKey(state);
		if (visited.has(key)) continue;
		visited.add(key);
		modules.add(state.callable.module);
		const usedBindings = new Set<string>();
		for (const invocation of invocationsIn(state.callable)) {
			const invocationSite = anchorSite(
				state.callable.module,
				invocation.target,
				invocation.label,
			);
			const targetSymbol = valueSymbol(state.callable.module, invocation.target);
			const bound = boundCallableOf(
				analyzer,
				state.callable.module,
				invocation.target,
				state.bindings,
			);
			if (bound !== null) usedBindings.add(bound.parameter);
			const target = invocation.target as RichNode;
			const superClass =
				target.type === 'Super' && state.callable.kind === 'class'
					? (state.callable.node as RichNode).superClass
					: null;
			const methodReceiver =
				target.type === 'MemberExpression' && target.object !== undefined
					? classReceiver(
							analyzer,
							state.callable.module,
							target.object,
							state.callable,
							state.values,
						)
					: null;
			const methodKey =
				target.type === 'MemberExpression'
					? staticPropertyKey(
							state.callable.module,
							target.property,
							Boolean(target.computed),
						)
					: null;
			const method =
				methodReceiver === null || methodKey === null
					? null
					: classMethodCallable(analyzer, methodReceiver, methodKey);
			if (method?.kind === 'unresolved') {
				gaps.push({
					site: anchorSite(
						state.callable.module,
						invocation.target,
						'class-method-lookup-boundary',
					),
					reason: 'linked-set-boundary',
					detail: 'Class method lookup contains an unnormalizable declaration key.',
				});
				continue;
			}
			const callee =
				bound?.binding.callable ??
				(method?.kind === 'found' ? method.callable : null) ??
				(superClass === null || superClass === undefined
					? callableOf(analyzer, state.callable.module, invocation.target)
					: callableOf(analyzer, state.callable.module, superClass));
			if (callee === null) {
				gaps.push(
					isParameterBinding(state.callable, targetSymbol)
						? {
								site: anchorSite(
									state.callable.module,
									invocation.target,
									'unproven-parameter-invocation',
								),
								reason: 'higher-order-call-boundary',
								detail: 'Invoked parameter has no statically proven callable binding.',
							}
						: invocationBoundary(state.callable.module, invocation),
				);
				for (const argument of invocation.arguments) {
					const argumentBinding = boundCallableOf(
						analyzer,
						state.callable.module,
						argument.node,
						state.bindings,
					);
					const callback =
						argumentBinding?.binding.callable ??
						callableOf(analyzer, state.callable.module, argument.node);
					if (callback !== null) {
						if (argumentBinding !== null) usedBindings.add(argumentBinding.parameter);
						gaps.push({
							site: anchorSite(
								state.callable.module,
								argument.node,
								'opaque-callback-boundary',
							),
							reason: 'higher-order-call-boundary',
							detail: 'Callback flow into an opaque callee cannot be proven.',
						});
					}
				}
				continue;
			}
			const witness = [
				...state.witness,
				...(bound?.binding.via ?? []),
				...(methodReceiver?.via ?? []),
				...invocation.prefix,
				invocationSite,
				...(method?.kind === 'found' ? [method.declaration] : []),
			];
			if (callee.symbol !== null && callee.symbol !== entry) {
				const resultKey = symbolKey(callee.symbol);
				if (!results.has(resultKey))
					results.set(resultKey, { symbol: anchorSymbol(callee.symbol), witness });
			}
			if (
				invocation.node.type === 'CallExpression' &&
				target.type !== 'Super' &&
				callee.kind === 'class'
			) {
				gaps.push({
					site: anchorSite(
						state.callable.module,
						invocation.target,
						'invalid-class-call-boundary',
					),
					reason: 'unsupported-syntax',
					detail: 'Calling a JavaScript class is invalid and does not execute construction semantics.',
				});
				continue;
			}
			if (invocation.node.type === 'JSXOpeningElement' && callee.kind === 'class') {
				gaps.push({
					site: anchorSite(
						state.callable.module,
						invocation.target,
						'jsx-class-framework-boundary',
					),
					reason: 'linked-set-boundary',
					detail: 'JSX class execution beyond class identity depends on framework semantics.',
				});
				continue;
			}
			const parameters = parameterEntries(callee);
			const rawParameters = parameterNodes(callee);
			const restParameterIndex = rawParameters.findIndex(
				(parameter) => (parameter as RichNode).type === 'RestElement',
			);
			const bindings = new Map<string, BoundCallable>();
			const implicitArguments = new Map<number, BoundCallable>();
			const implicitValues = new Map<number, BoundValue>();
			const values = new Map<string, BoundValue>();
			const patterns: PatternInput[] = [];
			const suppliedParameters = new Set<number>();
			const suppliedValueParameters = new Set<number>();
			let hasUncertainArguments = false;
			if (invocation.label === 'implicit-base-constructor-edge')
				for (const [index, forwarded] of state.implicitArguments) {
					const parameter = parameters[index]?.symbol;
					if (parameter !== null && parameter !== undefined)
						bindings.set(symbolKey(parameter), forwarded);
					else if (callee.kind === 'class' && constructorFunction(callee) === null)
						implicitArguments.set(index, forwarded);
					else
						gaps.push({
							site: forwarded.site,
							reason: 'higher-order-call-boundary',
							detail: 'Implicit constructor forwarding has no proven callable destination.',
						});
				}
			if (invocation.label === 'implicit-base-constructor-edge')
				if (restParameterIndex >= 0) {
					const forwarded = [...state.implicitValues]
						.filter(([index]) => index >= restParameterIndex)
						.sort(([left], [right]) => left - right)
						.map(([, value]) => value);
					const rawRest = rawParameters[restParameterIndex]!;
					const bindingPattern = parameterBinding(rawRest);
					const value: BoundValue = {
						module: state.callable.module,
						node: invocation.node,
						via: [
							anchorSite(
								state.callable.module,
								invocation.node,
								'implicit-rest-argument-array-edge',
							),
						],
						elements: forwarded,
					};
					suppliedValueParameters.add(restParameterIndex);
					bindPatternValues(callee.module, bindingPattern, value, values);
					if (
						(bindingPattern as RichNode).type === 'ObjectPattern' ||
						(bindingPattern as RichNode).type === 'ArrayPattern'
					)
						patterns.push({ pattern: bindingPattern, value, prefix: [] });
				}
			if (invocation.label === 'implicit-base-constructor-edge')
				for (const [index, value] of state.implicitValues) {
					if (restParameterIndex >= 0 && index >= restParameterIndex) continue;
					const parameter = parameterNodes(callee)[index];
					if (parameter === undefined) {
						if (callee.kind === 'class' && constructorFunction(callee) === null)
							implicitValues.set(index, value);
						else
							gaps.push({
								site: value.via.at(-1)!,
								reason: 'linked-set-boundary',
								detail: 'Implicit constructor value has no proven parameter destination.',
							});
						continue;
					}
					suppliedValueParameters.add(index);
					const parameterNode = parameter as RichNode;
					const bindingPattern =
						parameterNode.type === 'AssignmentPattern' &&
						parameterNode.left !== undefined
							? parameterNode.left
							: parameter;
					bindPatternValues(callee.module, bindingPattern, value, values);
					if (
						(bindingPattern as RichNode).type === 'ObjectPattern' ||
						(bindingPattern as RichNode).type === 'ArrayPattern'
					)
						patterns.push({ pattern: bindingPattern, value, prefix: [] });
				}
			for (const argument of invocation.arguments) {
				const staticArgument = argumentValue(
					state.callable.module,
					argument.node,
					state.values,
				);
				const parameterNode =
					argument.parameterIndex === null ||
					(restParameterIndex >= 0 && argument.parameterIndex >= restParameterIndex)
						? undefined
						: rawParameters[argument.parameterIndex];
				if (parameterNode !== undefined) {
					if (argument.parameterIndex !== null)
						suppliedValueParameters.add(argument.parameterIndex);
					const parameter = parameterNode as RichNode;
					const isUndefined = staticallyUndefined(state.callable.module, argument.node);
					const value =
						parameter.type === 'AssignmentPattern' &&
						isUndefined &&
						parameter.right !== undefined
							? {
									module: callee.module,
									node: parameter.right,
									via: [
										anchorSite(
											callee.module,
											parameter.right,
											'pattern-default-value-edge',
										),
									],
								}
							: staticArgument;
					const bindingPattern =
						parameter.type === 'AssignmentPattern' && parameter.left !== undefined
							? parameter.left
							: parameterNode;
					bindPatternValues(callee.module, bindingPattern, value, values);
					if (
						(bindingPattern as RichNode).type === 'ObjectPattern' ||
						(bindingPattern as RichNode).type === 'ArrayPattern'
					)
						patterns.push({ pattern: bindingPattern, value, prefix: [] });
				}
				if (
					argument.parameterIndex !== null &&
					callee.kind === 'class' &&
					constructorFunction(callee) === null &&
					invocation.node.type === 'NewExpression'
				)
					implicitValues.set(argument.parameterIndex, staticArgument);
				if (argument.parameterIndex === null) hasUncertainArguments = true;
				else if (
					(restParameterIndex < 0 || argument.parameterIndex < restParameterIndex) &&
					!staticallyUndefined(state.callable.module, argument.node)
				)
					suppliedParameters.add(argument.parameterIndex);
				if (staticallyUndefined(state.callable.module, argument.node)) continue;
				const argumentBinding = boundCallableOf(
					analyzer,
					state.callable.module,
					argument.node,
					state.bindings,
				);
				const callback =
					argumentBinding?.binding.callable ??
					callableOf(analyzer, state.callable.module, argument.node);
				if (callback === null) continue;
				if (argumentBinding !== null) usedBindings.add(argumentBinding.parameter);
				const parameter =
					argument.parameterIndex === null ||
					(restParameterIndex >= 0 && argument.parameterIndex >= restParameterIndex)
						? undefined
						: parameters[argument.parameterIndex]?.symbol;
				if (parameter !== null && parameter !== undefined) {
					const site = anchorSite(
						state.callable.module,
						argument.node,
						'higher-order-call-boundary',
					);
					bindings.set(symbolKey(parameter), {
						callable: callback,
						site,
						via: argumentBinding?.binding.via ?? [],
					});
				} else if (
					argument.parameterIndex !== null &&
					callee.kind === 'class' &&
					constructorFunction(callee) === null &&
					invocation.node.type === 'NewExpression'
				)
					implicitArguments.set(argument.parameterIndex, {
						callable: callback,
						site: anchorSite(
							state.callable.module,
							argument.node,
							'higher-order-call-boundary',
						),
						via: argumentBinding?.binding.via ?? [],
					});
				else
					gaps.push({
						site: anchorSite(
							state.callable.module,
							argument.node,
							'higher-order-call-boundary',
						),
						reason: 'higher-order-call-boundary',
						detail: 'No statically corresponding callable parameter accepts this callback.',
					});
			}
			if (restParameterIndex >= 0 && invocation.label !== 'implicit-base-constructor-edge') {
				const rawRest = rawParameters[restParameterIndex]!;
				const bindingPattern = parameterBinding(rawRest);
				const restArguments = invocation.arguments.filter(
					(argument) =>
						argument.parameterIndex !== null &&
						argument.parameterIndex >= restParameterIndex,
				);
				if (hasUncertainArguments) {
					gaps.push({
						site: anchorSite(
							callee.module,
							bindingPattern,
							'ambiguous-rest-parameter-boundary',
						),
						reason: 'linked-set-boundary',
						detail: 'Spread arguments prevent exact rest-parameter binding.',
					});
				} else {
					const elements = restArguments.map((argument) =>
						argumentValue(state.callable.module, argument.node, state.values),
					);
					const value: BoundValue = {
						module: state.callable.module,
						node: invocation.node,
						via: [
							anchorSite(
								state.callable.module,
								invocation.node,
								'rest-argument-array-edge',
							),
						],
						elements,
					};
					suppliedValueParameters.add(restParameterIndex);
					bindPatternValues(callee.module, bindingPattern, value, values);
					if (
						(bindingPattern as RichNode).type === 'ObjectPattern' ||
						(bindingPattern as RichNode).type === 'ArrayPattern'
					)
						patterns.push({ pattern: bindingPattern, value, prefix: [] });
				}
			}
			for (const [index, rawParameter] of parameterNodes(callee).entries()) {
				if (suppliedValueParameters.has(index)) continue;
				const parameter = rawParameter as RichNode;
				const bindingPattern = parameterBinding(rawParameter);
				if (
					(bindingPattern as RichNode).type !== 'ObjectPattern' &&
					(bindingPattern as RichNode).type !== 'ArrayPattern'
				)
					continue;
				if (parameter.type === 'AssignmentPattern' && parameter.right !== undefined) {
					const value: BoundValue = {
						module: callee.module,
						node: parameter.right,
						via: [
							anchorSite(
								callee.module,
								parameter.right,
								'pattern-default-value-edge',
							),
						],
					};
					bindPatternValues(callee.module, bindingPattern, value, values);
					patterns.push({ pattern: bindingPattern, value, prefix: [] });
					continue;
				}
				gaps.push({
					site: anchorSite(
						callee.module,
						bindingPattern,
						'unproven-pattern-parameter-boundary',
					),
					reason: 'linked-set-boundary',
					detail: 'Binding-pattern parameter has no statically proven input value.',
				});
			}
			if (!hasUncertainArguments)
				for (const [index, parameter] of parameters.entries()) {
					if (
						parameter.symbol === null ||
						parameter.defaultValue === null ||
						suppliedParameters.has(index) ||
						bindings.has(symbolKey(parameter.symbol))
					)
						continue;
					const defaultBinding = boundCallableOf(
						analyzer,
						callee.module,
						parameter.defaultValue,
						bindings,
					);
					const callback =
						defaultBinding?.binding.callable ??
						callableOf(analyzer, callee.module, parameter.defaultValue);
					if (callback === null) continue;
					const site = anchorSite(
						callee.module,
						parameter.defaultValue,
						'default-callable-binding-edge',
					);
					bindings.set(symbolKey(parameter.symbol), {
						callable: callback,
						site,
						via: [...(defaultBinding?.binding.via ?? []), site],
					});
				}
			queue.push({
				callable: callee,
				witness,
				bindings,
				implicitArguments,
				implicitValues,
				values,
				patterns,
			});
		}
		for (const access of propertyAccessesIn(state.callable, state.patterns)) {
			const namespace = resolveValue(analyzer, access.receiverModule, access.receiver);
			if (namespace?.kind === 'namespace') continue;
			const receiver = classReceiver(
				analyzer,
				access.receiverModule,
				access.receiver,
				state.callable,
				state.values,
			);
			if (receiver === null || access.key === null) {
				gaps.push({
					site: anchorSite(
						state.callable.module,
						access.node,
						`accessor-${access.mode}-receiver-boundary`,
					),
					reason:
						access.boundaryReason ??
						(access.key === null ? 'dynamic-member-access' : 'linked-set-boundary'),
					detail: 'Accessor receiver or property identity is not structurally provable.',
				});
				continue;
			}
			const accessor = accessorCallable(analyzer, receiver, access.key, access.mode);
			if (accessor.kind === 'absent') continue;
			if (accessor.kind === 'unresolved') {
				gaps.push({
					site: anchorSite(
						state.callable.module,
						access.node,
						`accessor-${access.mode}-hierarchy-boundary`,
					),
					reason: 'linked-set-boundary',
					detail: 'Accessor lookup leaves the statically linked class hierarchy.',
				});
				continue;
			}
			const accessBindings = new Map<string, BoundCallable>();
			const accessValues = new Map<string, BoundValue>();
			const accessPatterns: PatternInput[] = [];
			if (access.mode === 'set' && access.value !== null) {
				const boundValue = boundCallableOf(
					analyzer,
					state.callable.module,
					access.value,
					state.bindings,
				);
				const callback =
					boundValue?.binding.callable ??
					callableOf(analyzer, state.callable.module, access.value);
				const parameter = parameterEntries(accessor.callable)[0]?.symbol;
				if (callback !== null && parameter !== null && parameter !== undefined) {
					if (boundValue !== null) usedBindings.add(boundValue.parameter);
					const site = anchorSite(
						state.callable.module,
						access.value,
						'accessor-setter-binding',
					);
					accessBindings.set(symbolKey(parameter), {
						callable: callback,
						site,
						via: boundValue?.binding.via ?? [],
					});
				}
				if (parameter !== null && parameter !== undefined)
					accessValues.set(
						symbolKey(parameter),
						argumentValue(state.callable.module, access.value, state.values),
					);
				const parameterNode = parameterNodes(accessor.callable)[0];
				if (parameterNode !== undefined) {
					const value = argumentValue(state.callable.module, access.value, state.values);
					bindPatternValues(accessor.callable.module, parameterNode, value, accessValues);
					if (
						(parameterNode as RichNode).type === 'ObjectPattern' ||
						(parameterNode as RichNode).type === 'ArrayPattern'
					)
						accessPatterns.push({ pattern: parameterNode, value, prefix: [] });
				}
			}
			queue.push({
				callable: accessor.callable,
				witness: [
					...state.witness,
					...receiver.via,
					...access.prefix,
					anchorSite(state.callable.module, access.node, `accessor-${access.mode}-edge`),
					accessor.declaration,
				],
				bindings: accessBindings,
				implicitArguments: new Map(),
				implicitValues: new Map(),
				values: accessValues,
				patterns: accessPatterns,
			});
		}
		for (const [parameter, binding] of state.bindings)
			if (!usedBindings.has(parameter))
				gaps.push({
					site: binding.site,
					reason: 'higher-order-call-boundary',
					detail: 'The callee does not statically invoke or forward this callback parameter.',
				});
		if (
			state.callable.kind === 'class' &&
			constructorFunction(state.callable) === null &&
			(state.callable.node as RichNode).superClass == null
		)
			for (const binding of state.implicitArguments.values())
				gaps.push({
					site: binding.site,
					reason: 'higher-order-call-boundary',
					detail: 'Implicit base constructor does not statically consume this callback.',
				});
	}
	gaps.push(...moduleGaps(analyzer, modules));
	return finish(analyzer, request, [...results.values()], gaps);
}
