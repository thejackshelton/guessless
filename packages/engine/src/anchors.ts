import type { Module, Symbol } from 'yuku-analyzer';
import { sha256 } from './canonicalize.ts';
import type { SymbolAnchor } from './contracts.ts';

type YukuNode = Parameters<Module['symbolOf']>[0];
type PositionedNode = YukuNode & { start: number; end: number; type: string };

function nodeFingerprint(module: Module, node: PositionedNode): string {
	return sha256({ type: node.type, source: module.source.slice(node.start, node.end) });
}

function typePath(module: Module, node: YukuNode): string[] {
	const path: string[] = [];
	let current: YukuNode | null = node;
	while (current !== null) {
		path.push(current.type);
		current = module.parentOf(current);
	}
	return path.reverse();
}

function matchingNodes(module: Module, path: readonly string[], fingerprint: string): YukuNode[] {
	const matches: YukuNode[] = [];
	module.walk({
		enter(node) {
			if (
				nodeFingerprint(module, node as PositionedNode) === fingerprint &&
				typePath(module, node).join('\u0000') === path.join('\u0000')
			)
				matches.push(node);
		},
	});
	return matches;
}

function nodeIdentity(module: Module, node: YukuNode): string {
	if (node.type === 'Program') return 'scope:Program';
	const fingerprint = nodeFingerprint(module, node as PositionedNode);
	const path = typePath(module, node);
	const occurrence = matchingNodes(module, path, fingerprint).indexOf(node);
	return `scope:${path.join('>')}:${fingerprint}:${occurrence}`;
}

function scopePath(symbol: Symbol): string[] {
	return [...symbol.scope.ancestors()]
		.reverse()
		.map((scope) => `${scope.kind}:${nodeIdentity(symbol.module, scope.node)}`);
}

function declarationUnit(module: Module, declaration: PositionedNode): PositionedNode {
	let current = declaration;
	while (true) {
		const parent = module.parentOf(current) as PositionedNode | null;
		if (
			parent === null ||
			[
				'VariableDeclarator',
				'FunctionDeclaration',
				'ClassDeclaration',
				'TSTypeAliasDeclaration',
				'TSInterfaceDeclaration',
				'TSEnumDeclaration',
				'ImportSpecifier',
				'ImportDefaultSpecifier',
				'ImportNamespaceSpecifier',
			].includes(parent.type)
		)
			return parent ?? current;
		current = parent;
	}
}

export function anchorSymbol(symbol: Symbol): SymbolAnchor {
	const declarations = symbol.declarations as PositionedNode[];
	if (declarations.length === 0)
		throw new TypeError('cannot anchor a symbol without a declaration');
	const units = declarations.map((node) => declarationUnit(symbol.module, node));
	return {
		schema: 'guessless.symbol-anchor/v1',
		file: symbol.module.path,
		semanticPath: [
			...scopePath(symbol),
			`symbol:${symbol.name}`,
			`declaration:${units[0].type}`,
		],
		fingerprint: sha256(
			units.map((node) => ({
				type: node.type,
				source: symbol.module.source.slice(node.start, node.end),
			})),
		),
	};
}

export function anchorSite(
	module: Module,
	node?: YukuNode,
	label = 'module',
	occurrence = 0,
): SymbolAnchor {
	if (node === undefined) {
		return {
			schema: 'guessless.symbol-anchor/v1',
			file: module.path,
			semanticPath: [`module:${label}`, `occurrence:${occurrence}`],
			fingerprint: sha256({ label, source: module.source }),
		};
	}
	const owner = module.symbolOf(node);
	if (owner !== null && owner.declarations.includes(node)) return anchorSymbol(owner);
	const path = typePath(module, node);
	const fingerprint = nodeFingerprint(module, node as PositionedNode);
	const siteOccurrence = matchingNodes(module, path, fingerprint).indexOf(node);
	if (siteOccurrence < 0) throw new TypeError('cannot anchor a node outside its module AST');
	return {
		schema: 'guessless.symbol-anchor/v1',
		file: module.path,
		semanticPath: [`site:${label}`, ...path, `occurrence:${siteOccurrence}`],
		fingerprint,
	};
}

export function resolveSymbolAnchor(
	modules: ReadonlyMap<string, Module>,
	anchor: SymbolAnchor,
): Symbol | null {
	const module = modules.get(anchor.file);
	if (module === undefined) return null;
	const matches = module.symbols.filter((symbol) => {
		try {
			const candidate = anchorSymbol(symbol);
			return (
				candidate.fingerprint === anchor.fingerprint &&
				candidate.semanticPath.join('\u0000') === anchor.semanticPath.join('\u0000')
			);
		} catch {
			return false;
		}
	});
	return matches.length === 1 ? matches[0] : null;
}

export function resolveSiteAnchor(
	modules: ReadonlyMap<string, Module>,
	anchor: SymbolAnchor,
): YukuNode | null {
	const module = modules.get(anchor.file);
	if (module === undefined) return null;
	const first = anchor.semanticPath[0];
	if (first?.startsWith('module:')) {
		const label = first.slice('module:'.length);
		return anchor.fingerprint === sha256({ label, source: module.source }) ? module.ast : null;
	}
	if (!first?.startsWith('site:')) return null;
	const occurrencePart = anchor.semanticPath.at(-1);
	if (!occurrencePart?.startsWith('occurrence:')) return null;
	const occurrence = Number(occurrencePart.slice('occurrence:'.length));
	if (!Number.isSafeInteger(occurrence) || occurrence < 0) return null;
	const path = anchor.semanticPath.slice(1, -1);
	return matchingNodes(module, path, anchor.fingerprint)[occurrence] ?? null;
}

export function resolveAnchor(
	modules: ReadonlyMap<string, Module>,
	anchor: SymbolAnchor,
): Symbol | YukuNode | null {
	return resolveSymbolAnchor(modules, anchor) ?? resolveSiteAnchor(modules, anchor);
}
