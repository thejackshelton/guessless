import { expect, test } from 'vitest';
import {
	GuesslessEngine,
	type Receipt,
	type ReferenceResult,
	type SymbolAnchor,
} from '../src/index.ts';

/**
 * Reference completeness for the two defect classes the adoption evaluation
 * found (docs/evidence/adoption-eval-fable-v1/verdict.md, D2 and D3).
 *
 * D2: `referencesOf` returned local export specifiers but silently omitted
 * import specifiers and cross-module re-export specifiers, so a rename driven
 * by a `complete` receipt missed every site that names the symbol at a module
 * boundary. The tests below assert the *class*: whatever the fixture shape,
 * every occurrence of the name outside the declaration is a result.
 *
 * D3: `writesOf` classified assignments only, so a binding mutated by ten
 * `.push(...)` calls answered `complete` with zero results. The engine cannot
 * prove a call mutates its receiver and must never claim it does, so the site
 * is named as an unresolved possible mutation instead — never claimed, never
 * silent.
 */

const API_SOURCE =
	'export function sendTelemetry(event: string): number {\n\treturn event.length;\n}\n';

function label(site: SymbolAnchor): string {
	return site.semanticPath[0] ?? '';
}

function labelsOf(results: readonly ReferenceResult[]): string[] {
	return results.map((result) => label(result.site)).sort();
}

/** The exact source text a site anchor cites, proving what a rename would edit. */
function sourceOf(engine: GuesslessEngine, site: SymbolAnchor): string {
	const resolved = engine.resolve(site) as { start: number; end: number } | null;
	expect(resolved, `site is unresolvable: ${JSON.stringify(site)}`).not.toBeNull();
	const module = engine.module(site.file)!;
	return module.source.slice(resolved!.start, resolved!.end);
}

/**
 * Every occurrence of a bare identifier across the whole supplied set. A rename
 * of a uniquely-named symbol must touch exactly these, so `results + 1` (the
 * declaration, which `referencesOf` never returns) must account for all of
 * them: a site that goes missing anywhere in the graph fails this.
 */
function nameOccurrences(engine: GuesslessEngine, name: string): number {
	let count = 0;
	for (const module of engine.analyzer.modules.values())
		count += module.source.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
	return count;
}

function expectComplete<T>(receipt: Receipt<T>): readonly T[] {
	expect(
		receipt.state,
		JSON.stringify(receipt.state === 'partial' ? receipt.unresolved : receipt),
	).toBe('complete');
	return receipt.results;
}

test('D2: a barrel rename fixture returns every specifier site alongside the call sites', () => {
	const engine = new GuesslessEngine();
	engine.addFile('api.ts', API_SOURCE);
	engine.addFile('barrel.ts', "export { sendTelemetry } from './api.ts';\n");
	engine.addFile(
		'consumer-a.ts',
		[
			"import { sendTelemetry } from './barrel.ts';",
			"export const first = (): number => sendTelemetry('first');",
			"export const second = (): number => sendTelemetry('second');",
			'',
		].join('\n'),
	);
	engine.addFile(
		'consumer-b.ts',
		[
			"import { sendTelemetry } from './api.ts';",
			"export const third = (): number => sendTelemetry('third');",
			'export { sendTelemetry };',
			'',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('api.ts', 'sendTelemetry')!;
	const receipt = engine.referencesOf(target);
	const results = expectComplete(receipt);
	expect(engine.verify(receipt)).toBe(true);

	// Seven sites: one cross-module re-export specifier, two import specifiers,
	// one local export specifier, three calls.
	expect(results).toHaveLength(7);
	expect(labelsOf(results)).toEqual([
		'site:import-specifier',
		'site:import-specifier',
		'site:reexport-specifier',
		'site:reference',
		'site:reference',
		'site:reference',
		'site:reference',
	]);
	expect(results.every((result) => result.access === 'read')).toBe(true);
	expect(new Set(results.map((result) => JSON.stringify(result.site))).size).toBe(7);
	expect(new Set(results.map((result) => result.site.file))).toEqual(
		new Set(['barrel.ts', 'consumer-a.ts', 'consumer-b.ts']),
	);
	// Every site is real text a rename has to rewrite, and nothing is left over.
	for (const result of results) expect(sourceOf(engine, result.site)).toContain('sendTelemetry');
	expect(results.length + 1).toBe(nameOccurrences(engine, 'sendTelemetry'));

	// The same sites are reads; none of them is a write.
	expect(expectComplete(engine.readsOf(target))).toHaveLength(7);
	expect(expectComplete(engine.writesOf(target))).toEqual([]);
});

test('D2: an aliased import specifier and its aliased uses both attribute to the origin', () => {
	const engine = new GuesslessEngine();
	engine.addFile('api.ts', API_SOURCE);
	engine.addFile(
		'consumer.ts',
		[
			"import { sendTelemetry as track } from './api.ts';",
			"export const run = (): number => track('run');",
			"export const again = (): number => track('again');",
			'',
		].join('\n'),
	);
	engine.link();
	const results = expectComplete(engine.referencesOf(engine.anchor('api.ts', 'sendTelemetry')!));
	expect(results).toHaveLength(3);
	const specifiers = results.filter((result) => label(result.site) === 'site:import-specifier');
	expect(specifiers).toHaveLength(1);
	// The specifier site spans the whole `x as y` clause: the imported half is
	// what a rename rewrites, the local half is the alias it must leave alone.
	expect(sourceOf(engine, specifiers[0].site)).toBe('sendTelemetry as track');
	const uses = results.filter((result) => label(result.site) === 'site:reference');
	expect(uses).toHaveLength(2);
	for (const use of uses) expect(sourceOf(engine, use.site)).toBe('track');
});

test('D2: an export * chain hides no site, and the star declaration invents none', () => {
	const engine = new GuesslessEngine();
	engine.addFile('api.ts', API_SOURCE);
	engine.addFile('star.ts', "export * from './api.ts';\n");
	engine.addFile(
		'consumer.ts',
		[
			"import { sendTelemetry } from './star.ts';",
			"export const run = (): number => sendTelemetry('run');",
			'',
		].join('\n'),
	);
	engine.link();
	const receipt = engine.referencesOf(engine.anchor('api.ts', 'sendTelemetry')!);
	const results = expectComplete(receipt);
	// `export * from './api.ts'` names no symbol, so there is no specifier to
	// cite there and nothing at that boundary for a rename to rewrite. What the
	// star must not do is swallow the sites *through* it: the consumer's import
	// specifier and its call are both returned, and the occurrence count proves
	// no fourth occurrence of the name exists anywhere in the set. Completeness
	// is therefore earned, not assumed — no gap is invented to cover a boundary
	// that carries nothing.
	expect(labelsOf(results)).toEqual(['site:import-specifier', 'site:reference']);
	expect(results.every((result) => result.site.file === 'consumer.ts')).toBe(true);
	expect(results.length + 1).toBe(nameOccurrences(engine, 'sendTelemetry'));
});

test('D3: ten push calls on a parameter are named, never a bare complete with no results', () => {
	const engine = new GuesslessEngine();
	const pushes = Array.from({ length: 10 }, (_, index) => `\trecords.push('${index}');`);
	engine.addFile(
		'collect.ts',
		[
			'export function collect(records: string[]): number {',
			...pushes,
			'\treturn records.length;',
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('collect.ts', 'records')!;
	const receipt = engine.writesOf(target);

	// The defect was `complete` with zero results while ten calls mutated the
	// binding. The engine still claims no write — a call is not proof of one —
	// but every one of the ten sites is named.
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected named mutation uncertainty');
	expect(receipt.results).toEqual([]);
	expect(engine.verify(receipt)).toBe(true);
	expect(receipt.unresolved).toHaveLength(10);
	expect(new Set(receipt.unresolved.map((item) => item.reason))).toEqual(
		new Set(['method-call-mutation-uncertain']),
	);
	expect(new Set(receipt.unresolved.map((item) => JSON.stringify(item.site))).size).toBe(10);
	for (const item of receipt.unresolved) {
		expect(sourceOf(engine, item.site)).toBe('records.push');
		expect(item.detail).toContain('records');
	}
	// `records.length` is read, not called: it earns no uncertainty of its own.
	const reads = engine.readsOf(target);
	expect(reads.results).toHaveLength(11);
});

test('D3: non-mutating member calls are never reported as writes', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'scan.ts',
		[
			'export function scan(items: string[]): string[] {',
			"\tif (items.includes('a')) return [];",
			'\treturn items.map((item) => item);',
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('scan.ts', 'items')!;
	const writes = engine.writesOf(target);
	// No result at all: `.map()` and `.includes()` are not mutations and the
	// engine must not trade a missed site for an invented one.
	expect(writes.results).toEqual([]);
	expect(engine.referencesOf(target).results.every((result) => result.access === 'read')).toBe(
		true,
	);
	expect(writes.state).toBe('partial');
	if (writes.state !== 'partial') throw new Error('expected named call uncertainty');
	expect(writes.unresolved.map((item) => item.reason)).toEqual([
		'method-call-mutation-uncertain',
		'method-call-mutation-uncertain',
	]);
	expect(writes.unresolved.map((item) => sourceOf(engine, item.site)).sort()).toEqual([
		'items.includes',
		'items.map',
	]);
});

test('negative control: a fixture with no specifiers and no calls answers byte-identically', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'neutral.ts',
		[
			'export let total = 0;',
			'export function bump(step: number): number {',
			'\ttotal = total + step;',
			'\ttotal += step;',
			'\ttotal++;',
			'\treturn total;',
			'}',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('neutral.ts', 'total')!;
	const references = engine.referencesOf(target);
	// Assignment forms are classified exactly as before: one write target, one
	// read of the same statement, two read-writes, one returned read.
	expect(references.results.map((result) => result.access).sort()).toEqual([
		'read',
		'read',
		'read-write',
		'read-write',
		'write',
	]);
	// The integrity hashes below were computed from the engine at commit 4b16b94,
	// before the D2/D3 change, over this exact source. They cover the whole
	// receipt — request, snapshot, every result anchor, and state — so a single
	// altered byte in any answer for a fixture that has no specifier site and no
	// member call would fail here. The blast radius of the fix is exactly the
	// two defect classes and nothing else.
	expect(references.integrity).toBe(
		'13114b2c3e9e991be459f9aa50d0c696fb8357b7289876b36073474b1455b089',
	);
	expect(engine.readsOf(target).integrity).toBe(
		'bb1b366601cd2cd763e19e2ab6241cd483780409ece514313cee7c8092015d6f',
	);
	expect(engine.writesOf(target).integrity).toBe(
		'58f874e27de861ee1b8c7a64808e18b635acdb261adeff195225c6961d19814b',
	);
	expect(references.state).toBe('complete');
});
