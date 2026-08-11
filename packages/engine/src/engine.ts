import { Analyzer, type Module, type Space, type Symbol } from 'yuku-analyzer';
import { anchorSymbol, resolveAnchor } from './anchors.ts';
import {
	makeReceipt,
	verifyReceipt,
	type Receipt,
	type SafeChangeIntent,
	type SafeChangeTarget,
	type SymbolAnchor,
} from './contracts.ts';
import {
	capturesOf,
	definitionOf,
	exportedNames,
	referencesOf,
	resolveBinding,
} from './queries.ts';
import { reachableFrom, reaches } from './reachability.ts';
import { safeChangeImpact } from './safe-change.ts';
import { safeChangeImpactSummary } from './progressive.ts';
import { analyzerSnapshot } from './snapshot.ts';

const supported = /\.(?:[cm]?[jt]s|jsx|tsx)$/;

export class GuesslessEngine {
	readonly analyzer = new Analyzer();

	addFile(path: string, source: string): Module | Receipt<never> {
		if (!supported.test(path))
			return makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'refused',
				query: 'addFile',
				request: { kind: 'addFile', file: path },
				snapshot: this.snapshot(),
				results: [],
				reason: 'unsupported-language',
				detail: `Unsupported language for '${path}'.`,
			});
		return this.analyzer.addFile(path, source);
	}
	removeFile(path: string): boolean {
		return this.analyzer.removeFile(path);
	}
	link(): void {
		this.analyzer.link();
	}
	module(path: string): Module | undefined {
		return this.analyzer.module(path);
	}
	snapshot(): string {
		return analyzerSnapshot(this.analyzer);
	}
	verify(receipt: unknown): receipt is Receipt<unknown> {
		return verifyReceipt(receipt, this.snapshot());
	}

	anchor(file: string, symbolName: string): SymbolAnchor | null {
		const module = this.analyzer.module(file);
		const matches = module?.symbols.filter((symbol) => symbol.name === symbolName) ?? [];
		return matches.length === 1 ? anchorSymbol(matches[0]) : null;
	}
	resolve(anchor: SymbolAnchor) {
		return resolveAnchor(this.analyzer.modules, anchor);
	}
	definitionOf(anchor: SymbolAnchor) {
		return definitionOf(this.analyzer, anchor);
	}
	referencesOf(anchor: SymbolAnchor) {
		return referencesOf(this.analyzer, anchor);
	}
	readsOf(anchor: SymbolAnchor) {
		return referencesOf(this.analyzer, anchor, 'reads');
	}
	writesOf(anchor: SymbolAnchor) {
		return referencesOf(this.analyzer, anchor, 'writes');
	}
	exportedNames(file: string) {
		const module = this.analyzer.module(file);
		return module === undefined
			? makeReceipt({
					schema: 'guessless.receipt/v1',
					state: 'refused',
					query: 'exportedNames',
					request: { kind: 'exportedNames', file },
					snapshot: this.snapshot(),
					results: [],
					reason: 'unresolved-symbol',
					detail: `Module '${file}' is not in the linked set.`,
				})
			: exportedNames(module);
	}
	capturesOf(anchor: SymbolAnchor) {
		return capturesOf(this.analyzer, anchor);
	}
	reachableFrom(anchor: SymbolAnchor) {
		return reachableFrom(this.analyzer, anchor);
	}
	reaches(anchor: SymbolAnchor) {
		return reaches(this.analyzer, anchor);
	}
	safeChangeImpact(snapshot: string, intent: SafeChangeIntent, target: SafeChangeTarget) {
		return safeChangeImpact(this.analyzer, snapshot, intent, target);
	}
	safeChangeImpactSummary(snapshot: string, intent: SafeChangeIntent, target: SafeChangeTarget) {
		return safeChangeImpactSummary(this.analyzer, snapshot, intent, target);
	}
	resolveBinding(file: string, name: string, space: Space = 'value', from?: SymbolAnchor) {
		const module = this.analyzer.module(file);
		if (module === undefined)
			return makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'refused',
				query: 'resolveBinding',
				request: { kind: 'resolveBinding', file, name, space, scope: from ?? null },
				snapshot: this.snapshot(),
				results: [],
				reason: 'unresolved-symbol',
				detail: `Module '${file}' is not in the linked set.`,
			});
		if (
			from !== undefined &&
			(from.file !== file || this.analyzer.module(from.file) !== module)
		)
			return makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'refused',
				query: 'resolveBinding',
				request: { kind: 'resolveBinding', file, name, space, scope: from },
				snapshot: this.snapshot(),
				results: [],
				reason: 'unresolved-symbol',
				detail: 'The scope anchor belongs to a different module; resolution fails closed.',
			});
		const resolvedFrom = from === undefined ? null : resolveAnchor(this.analyzer.modules, from);
		if (from !== undefined && resolvedFrom === null)
			return makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'refused',
				query: 'resolveBinding',
				request: { kind: 'resolveBinding', file, name, space, scope: from },
				snapshot: this.snapshot(),
				results: [],
				reason: 'unresolved-symbol',
				detail: 'The scope anchor is stale or ambiguous.',
			});
		const fromScope =
			resolvedFrom === null
				? undefined
				: 'flags' in resolvedFrom
					? (resolvedFrom as Symbol).scope
					: module.scopeOf(resolvedFrom);
		return resolveBinding(this.analyzer, module, name, space, fromScope, from ?? null);
	}
}
