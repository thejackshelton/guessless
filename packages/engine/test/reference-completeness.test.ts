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
 *
 * D5 (docs/evidence/adoption-eval-fable-v2/report.md §1) is D3's residual, and
 * it cuts both ways — the tests below pin both directions, because a fix that
 * only widened would trade a missed site for a false one:
 *
 *  - *recall*: a binding handed to a callee as an argument escapes to a body
 *    this analysis does not read. An argument is syntactically a read, so
 *    `writesOf` filtered it out of results and named nothing — the mutation
 *    left no trace at all. It is now named `argument-escape-mutation-uncertain`.
 *  - *precision*: `method-call-mutation-uncertain` fired whenever a member call
 *    sat above the binding in the walk, including on receivers that were only
 *    the *result* of a call the binding was passed to
 *    (`Object.values(x).includes(v)`). That attributes to `x` a call made on a
 *    different value. The reason is now restricted to calls whose receiver is
 *    the queried binding itself.
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

test('D5: a binding passed as an argument is named as an escape, never claimed as a write', () => {
	const engine = new GuesslessEngine();
	// The markless shape (packages/serializer/src/value.ts:223…331): `records` is
	// both mutated through its own member and handed to callees that mutate it.
	engine.addFile(
		'encode.ts',
		[
			'export function encodeSlot(value: unknown, records: string[]): number {',
			'\trecords.push(String(value));',
			'\tencodeBuffer(value, records);',
			'\tconst nested = encodeSlot(value, records);',
			'\treturn records.length + nested;',
			'}',
			'function encodeBuffer(value: unknown, sink: string[]): void {',
			"\tsink.push('buffer');",
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('encode.ts', 'records')!;
	const writes = engine.writesOf(target);

	// Still no claim: an argument rebinds nothing, so nothing is a write.
	expect(writes.results).toEqual([]);
	expect(writes.state).toBe('partial');
	if (writes.state !== 'partial') throw new Error('expected named escape uncertainty');
	expect(engine.verify(writes)).toBe(true);

	const escapes = writes.unresolved.filter(
		(item) => item.reason === 'argument-escape-mutation-uncertain',
	);
	// Exactly the two argument positions: encodeBuffer(…, records) and the
	// recursive encodeSlot(…, records). `records.push` and `records.length` are
	// receiver and member reads, not argument positions, and earn no escape.
	expect(escapes).toHaveLength(2);
	expect(escapes.map((item) => sourceOf(engine, item.site))).toEqual(['records', 'records']);
	for (const escape of escapes) {
		expect(escape.detail).toContain("'records'");
		// The callee is named from structure, so a reader can see where it went.
		expect(escape.detail).toMatch(/'encodeBuffer'|'encodeSlot'/);
	}
	// Every citation resolves to real source, escapes included.
	expect(new Set(writes.unresolved.map((item) => JSON.stringify(item.site))).size).toBe(
		writes.unresolved.length,
	);
	// The receiver call is still named under its own reason — the two coexist and
	// neither absorbed the other.
	expect(
		writes.unresolved
			.filter((item) => item.reason === 'method-call-mutation-uncertain')
			.map((item) => sourceOf(engine, item.site)),
	).toEqual(['records.push']);
});

test('D5: an escape into a callee is named even when the callee is opaque or constructed', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'escape.ts',
		[
			"import { ship } from './opaque.ts';",
			'export function run(batch: string[]): void {',
			'\tship(batch);',
			'\tnew Collector(batch);',
			'\tconst held = { batch };',
			'\tvoid held;',
			'}',
			'declare class Collector {',
			'\tconstructor(items: string[]);',
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	const writes = engine.writesOf(engine.anchor('escape.ts', 'batch')!);
	expect(writes.results).toEqual([]);
	if (writes.state !== 'partial') throw new Error('expected named escape uncertainty');
	const escapes = writes.unresolved.filter(
		(item) => item.reason === 'argument-escape-mutation-uncertain',
	);
	// A plain call and a `new` both hand the reference out; both are named, and
	// the detail distinguishes them so the receipt says which construct escaped.
	expect(escapes).toHaveLength(2);
	expect(escapes.map((item) => item.detail).sort()).toEqual([
		"'batch' escapes as an argument to 'new Collector'; the callee's body is not analyzed for mutation, so whether it mutates the referenced value is unknown.",
		"'batch' escapes as an argument to 'ship'; the callee's body is not analyzed for mutation, so whether it mutates the referenced value is unknown.",
	]);
	// `{ batch }` is an aggregate that merely *contains* the binding and is passed
	// to nothing: it is a weaker claim than this reason makes, so it is not named
	// here.
	expect(escapes.every((item) => sourceOf(engine, item.site) === 'batch')).toBe(true);
});

test('D5: argument escapes are named only where the answer would otherwise omit them', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'flow.ts',
		[
			'export function run(items: string[]): number {',
			'\tconsume(items);',
			'\treturn items.length;',
			'}',
			'declare function consume(values: string[]): void;',
			'',
		].join('\n'),
	);
	engine.link();
	const target = engine.anchor('flow.ts', 'items')!;
	// `referencesOf` and `readsOf` return the argument site itself, so naming it
	// there would report one site twice — once as an answer, once as a hole in
	// the answer. Only `writesOf` filters reads out, and only there is the gap
	// the difference between a named site and silence.
	for (const receipt of [engine.referencesOf(target), engine.readsOf(target)]) {
		const named =
			receipt.state === 'partial'
				? receipt.unresolved.filter(
						(item) => item.reason === 'argument-escape-mutation-uncertain',
					)
				: [];
		expect(named).toEqual([]);
		expect(receipt.results.some((result) => sourceOf(engine, result.site) === 'items')).toBe(
			true,
		);
	}
	const writes = engine.writesOf(target);
	if (writes.state !== 'partial') throw new Error('expected named escape uncertainty');
	expect(
		writes.unresolved.filter((item) => item.reason === 'argument-escape-mutation-uncertain'),
	).toHaveLength(1);
});

test('D5: an escape names the first boundary once, not every call downstream of it', () => {
	const engine = new GuesslessEngine();
	// The versionless shape (internals/scripts/extract-intl.js:97): `plugins` goes
	// into `transform` inside an object, and `transform`'s result then flows into
	// `get`. Naming `get` would report the same one fact — plugins left — at ever
	// greater distance, against a callee that never saw `plugins` at all.
	engine.addFile(
		'chain.ts',
		[
			'export function run(plugins: string[]): unknown {',
			'\tconst output = transform({ plugins });',
			"\tconst messages = get(output, 'messages');",
			'\treturn messages;',
			'}',
			'declare function transform(options: { plugins: string[] }): unknown;',
			'declare function get(source: unknown, path: string): unknown;',
			'',
		].join('\n'),
	);
	engine.link();
	const writes = engine.writesOf(engine.anchor('chain.ts', 'plugins')!);
	const escapes =
		writes.state === 'partial'
			? writes.unresolved.filter(
					(item) => item.reason === 'argument-escape-mutation-uncertain',
				)
			: [];
	// `{ plugins }` is an aggregate, so even the first hop is below this reason's
	// threshold — and the derived `output` earns nothing either.
	expect(escapes).toEqual([]);
	expect(writes.results).toEqual([]);

	// The same chain with a *direct* first hop names exactly that hop, once.
	const direct = new GuesslessEngine();
	direct.addFile(
		'direct.ts',
		[
			'export function run(plugins: string[]): unknown {',
			'\tconst output = transform(plugins);',
			"\tconst messages = get(output, 'messages');",
			'\treturn messages;',
			'}',
			'declare function transform(values: string[]): unknown;',
			'declare function get(source: unknown, path: string): unknown;',
			'',
		].join('\n'),
	);
	direct.link();
	const receipt = direct.writesOf(direct.anchor('direct.ts', 'plugins')!);
	if (receipt.state !== 'partial') throw new Error('expected named escape uncertainty');
	const named = receipt.unresolved.filter(
		(item) => item.reason === 'argument-escape-mutation-uncertain',
	);
	expect(named).toHaveLength(1);
	expect(named[0]!.detail).toContain("'transform'");
});

test('D5: an aliased binding still earns a receiver gap — the first-boundary rule never silences one', () => {
	const engine = new GuesslessEngine();
	// `wrap` may return `items` itself, so `held.push(...)` may be a mutation of
	// `items`. The escape rule narrows *escape* naming only; a member call on the
	// alias is the classic aliased mutation and stays named. Losing this would be
	// the missed-and-unnamed failure the whole contract exists to prevent.
	engine.addFile(
		'alias.ts',
		[
			'export function run(items: string[]): void {',
			'\tconst held = wrap(items);',
			"\theld.push('x');",
			'}',
			'declare function wrap(values: string[]): string[];',
			'',
		].join('\n'),
	);
	engine.link();
	const writes = engine.writesOf(engine.anchor('alias.ts', 'items')!);
	if (writes.state !== 'partial') throw new Error('expected named uncertainty');
	expect(
		writes.unresolved
			.filter((item) => item.reason === 'method-call-mutation-uncertain')
			.map((item) => sourceOf(engine, item.site)),
	).toEqual(['held.push']);
	// And the escape into `wrap` is named at its own first boundary.
	expect(
		writes.unresolved
			.filter((item) => item.reason === 'argument-escape-mutation-uncertain')
			.map((item) => sourceOf(engine, item.site)),
	).toEqual(['items']);
});

test('D5: method-call uncertainty is restricted to calls whose receiver is the binding', () => {
	const engine = new GuesslessEngine();
	// The markless false alarm (packages/serializer/src/protocol-validation.ts:301):
	// the receiver of `.includes` is the fresh array `Object.values` returned, not
	// `arms`. Attributing that call to `arms` would be a mutation claim about a
	// value `arms` never was.
	engine.addFile(
		'guard.ts',
		[
			"export const arms = { a: 'a', b: 'b' } as const;",
			'export function isArm(value: string): boolean {',
			'\treturn Object.values(arms).includes(value as never);',
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	const writes = engine.writesOf(engine.anchor('guard.ts', 'arms')!);
	expect(writes.results).toEqual([]);
	const reasons =
		writes.state === 'partial' ? writes.unresolved.map((item) => item.reason) : [];
	expect(reasons).not.toContain('method-call-mutation-uncertain');
	// The real, honest uncertainty is one level down: `arms` escapes into
	// `Object.values`. No builtin allowlist suppresses it — see `argumentEscapeGap`.
	expect(reasons).toEqual(['argument-escape-mutation-uncertain']);
	if (writes.state !== 'partial') throw new Error('expected named escape uncertainty');
	expect(writes.unresolved[0]!.detail).toContain("'Object.values'");
});

test('D5: a method call on a different binding is never attributed to the queried one', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'sibling.ts',
		[
			'export function run(left: string[], right: string[]): number {',
			"\tright.push('x');",
			'\treturn left.length + right.length;',
			'}',
			'',
		].join('\n'),
	);
	engine.link();
	// `left` is never a receiver and never an argument: nothing may be named
	// against it, and the answer is a genuine, earned `complete`.
	const writes = engine.writesOf(engine.anchor('sibling.ts', 'left')!);
	expect(writes.results).toEqual([]);
	expect(writes.state).toBe('complete');
});

test('D5: reassignment from a self-receiver call keeps both the write and the receiver gap', () => {
	const engine = new GuesslessEngine();
	// The versionless shape (internals/scripts/extract-intl.js:26):
	// `plugins = plugins.filter(...)`. The assignment is a real write and is
	// claimed as one; the `.filter` call has `plugins` as its receiver, so it
	// stays named. `.filter` does not mutate, but proving that would need a
	// builtin model the engine deliberately does not have — when in doubt, name.
	engine.addFile(
		'plugins.ts',
		[
			"export let plugins: string[] = ['a', 'b'];",
			"plugins.push('react-intl');",
			"plugins = plugins.filter((p) => p !== 'styled-components');",
			'',
		].join('\n'),
	);
	engine.link();
	const writes = engine.writesOf(engine.anchor('plugins.ts', 'plugins')!);
	// The reassignment is claimed, not merely named.
	expect(writes.results.map((result) => result.access)).toEqual(['write']);
	if (writes.state !== 'partial') throw new Error('expected named call uncertainty');
	expect(
		writes.unresolved
			.filter((item) => item.reason === 'method-call-mutation-uncertain')
			.map((item) => sourceOf(engine, item.site))
			.sort(),
	).toEqual(['plugins.filter', 'plugins.push']);
	// The callback passed to `.filter` is not an escape of `plugins` itself.
	expect(
		writes.unresolved.filter(
			(item) => item.reason === 'argument-escape-mutation-uncertain',
		),
	).toEqual([]);
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
