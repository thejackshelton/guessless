import type { Module, Symbol } from 'yuku-analyzer';
import { anchorSite } from './anchors.ts';
import type { UnresolvedSite } from './contracts.ts';

/**
 * Export forms outside the ES module system (D4).
 *
 * `Module.exportedNames()` answers the ES question only: it enumerates
 * `export` declarations and `export *` chains. A CommonJS module states its
 * exports by assigning to the `module.exports` / `exports` objects, and TS
 * `export =` assigns a module's entire export value. Neither shape produces an
 * ES export record, so `exportedNames` used to return an empty result set with
 * nothing said about it: a consumer could not tell "this module exports
 * nothing" from "this module's exports are invisible to me".
 *
 * This module closes that hole without opening a second analysis. Nothing here
 * claims an exported *name* — guessless does not analyze CommonJS. It names the
 * constructs themselves as unresolved sites, so the receipt's silence becomes a
 * stated boundary and the answer degrades to 'partial'.
 *
 * What is detected, and why exactly this much:
 *   - references to the free (unresolved) names `exports` and `module`, the
 *     only evidence available that a file speaks CommonJS at all;
 *   - `module.exports` and any member chain rooted at either object, computed
 *     keys included;
 *   - bindings that alias one of those objects (`const m = module`,
 *     `const e = module.exports`), transitively, so an indirection does not buy
 *     silence;
 *   - TS `export = value`, whose export record carries no name.
 *
 * What is deliberately *not* detected, so that no honest ES receipt changes:
 *   - `module.<anything-but-exports>` (`module.hot`, webpack's HMR handle) is
 *     not an export form and is left alone;
 *   - a *resolved* local binding named `exports` or `module` that is not an
 *     alias of the free objects — a UMD factory parameter, say. Its identity as
 *     an exports object is a convention, not evidence, and guessing it would be
 *     the very thing this engine refuses to do.
 */

type YukuNode = Parameters<Module['symbolOf']>[0];
type RichNode = YukuNode & {
	type: string;
	name?: string;
	object?: YukuNode;
	property?: YukuNode;
	computed?: boolean;
	left?: YukuNode;
	id?: YukuNode;
	init?: YukuNode | null;
	expression?: YukuNode;
};

/** Which CommonJS object an expression evaluates to. */
type RootKind = 'module' | 'exports';

const transparentExpressions = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSTypeAssertion',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
]);

function unwrap(node: YukuNode): YukuNode {
	let current = node as RichNode;
	while (transparentExpressions.has(current.type) && current.expression !== undefined)
		current = current.expression as RichNode;
	return current;
}

function isIdentifier(node: RichNode, name: string): boolean {
	return node.type === 'Identifier' && node.name === name;
}

/** `<object>.exports`, non-computed, where `<object>` is the CommonJS `module`. */
function isExportsMember(node: RichNode, objectKind: RootKind | null): boolean {
	return (
		objectKind === 'module' &&
		node.type === 'MemberExpression' &&
		node.computed !== true &&
		node.property !== undefined &&
		isIdentifier(node.property as RichNode, 'exports')
	);
}

/**
 * The CommonJS object an expression denotes, or null. `aliases` carries the
 * bindings already proven to hold one of the objects, so indirection through a
 * variable resolves like the object itself.
 */
function rootKindOf(
	module: Module,
	node: YukuNode,
	aliases: ReadonlyMap<Symbol, RootKind>,
): RootKind | null {
	const expression = unwrap(node) as RichNode;
	if (expression.type === 'Identifier') {
		const reference = module.referenceOf(expression);
		if (reference === null) return null;
		if (reference.symbol !== null) return aliases.get(reference.symbol) ?? null;
		// A free `module` / `exports`: the CommonJS globals, by the only
		// evidence a single-file analysis can have.
		return reference.name === 'module' || reference.name === 'exports'
			? (reference.name as RootKind)
			: null;
	}
	if (expression.type !== 'MemberExpression' || expression.object === undefined) return null;
	return isExportsMember(expression, rootKindOf(module, expression.object, aliases))
		? 'exports'
		: null;
}

/**
 * Bindings initialized from a CommonJS object, to a fixed point: `const m =
 * module; const e = m.exports;` makes both `m` and `e` roots.
 */
function aliasRoots(module: Module): ReadonlyMap<Symbol, RootKind> {
	const aliases = new Map<Symbol, RootKind>();
	for (let pass = 0; pass <= module.symbols.length; pass += 1) {
		let changed = false;
		for (const symbol of module.symbols) {
			if (aliases.has(symbol)) continue;
			for (const declaration of symbol.declarations) {
				const parent = module.parentOf(declaration) as RichNode | null;
				if (
					parent === null ||
					parent.type !== 'VariableDeclarator' ||
					parent.id !== declaration ||
					parent.init === undefined ||
					parent.init === null
				)
					continue;
				const kind = rootKindOf(module, parent.init, aliases);
				if (kind === null) continue;
				aliases.set(symbol, kind);
				changed = true;
				break;
			}
		}
		if (!changed) break;
	}
	return aliases;
}

/** The outermost member chain built on `expression`, and whether it is keyed dynamically. */
function memberChain(
	module: Module,
	expression: YukuNode,
): { readonly node: YukuNode; readonly computed: boolean } {
	let current = expression;
	let computed = false;
	while (true) {
		const parent = module.parentOf(current) as RichNode | null;
		if (parent === null || parent.type !== 'MemberExpression' || parent.object !== current)
			return { node: current, computed };
		if (parent.computed === true) computed = true;
		current = parent;
	}
}

/** The assignment a member chain is the target of, or the chain itself. */
function constructNode(module: Module, chain: YukuNode): YukuNode {
	const parent = module.parentOf(chain) as RichNode | null;
	return parent !== null && parent.type === 'AssignmentExpression' && parent.left === chain
		? parent
		: chain;
}

function excerpt(module: Module, node: YukuNode): string {
	const { start, end } = node as YukuNode & { start: number; end: number };
	const text = module.source.slice(start, end).replaceAll(/\s+/gu, ' ').trim();
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Every export-like construct in `module` that the ES analysis cannot classify,
 * as unresolved sites. No exported name is claimed for any of them: the site is
 * the whole answer.
 */
export function unrecognizedExportSites(module: Module): UnresolvedSite[] {
	const sites: UnresolvedSite[] = [];
	const aliases = aliasRoots(module);
	const seen = new Set<YukuNode>();
	const roots: YukuNode[] = [];
	for (const reference of module.unresolvedReferences)
		if (reference.name === 'module' || reference.name === 'exports')
			roots.push(reference.node as YukuNode);
	for (const [symbol] of aliases)
		for (const reference of symbol.references) roots.push(reference.node as YukuNode);

	for (const root of roots) {
		const kind = rootKindOf(module, root, aliases);
		if (kind === null) continue;
		let exportsExpression: YukuNode = root;
		if (kind === 'module') {
			// The `module` object is only an export form through `.exports`.
			// `module.hot` and friends are other APIs and stay unnamed.
			const parent = module.parentOf(root) as RichNode | null;
			if (parent === null || parent.type !== 'MemberExpression' || parent.object !== root)
				continue;
			if (parent.computed === true) {
				// A computed key on `module` may or may not be 'exports'.
				// Structure proves neither, so the site is named for what it
				// is: an access nobody can classify.
				const site = anchorSite(module, constructNode(module, parent), 'export-form');
				sites.push({
					site,
					reason: 'dynamic-member-access',
					detail: `Computed member access '${excerpt(module, parent)}' on the CommonJS 'module' object may name 'exports'; the exported names, if any, are not claimed.`,
				});
				continue;
			}
			if (!isExportsMember(parent, 'module')) continue;
			exportsExpression = parent;
		}
		const chain = memberChain(module, exportsExpression);
		const construct = constructNode(module, chain.node);
		if (seen.has(construct)) continue;
		seen.add(construct);
		const assigned = (construct as RichNode).type === 'AssignmentExpression';
		sites.push({
			site: anchorSite(module, construct, 'export-form'),
			reason: 'unrecognized-export-form',
			detail: `CommonJS export ${assigned ? 'assignment' : 'expression'} '${excerpt(module, construct)}'${
				chain.computed ? ' uses a computed key and' : ''
			} lies outside the ES module system; guessless does not analyze it, so no exported name is claimed for it.`,
		});
	}

	for (const record of module.exports) {
		if (!record.isExportEquals) continue;
		sites.push({
			site: anchorSite(module, record.node as YukuNode, 'export-form'),
			reason: 'unrecognized-export-form',
			detail: `TypeScript 'export =' assigns this module's entire export value; the names it makes available are not ES export records, so none is claimed.`,
		});
	}
	return sites;
}
