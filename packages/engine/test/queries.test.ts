import { expect, test } from 'vitest';
import { anchorSite, anchorSymbol, GuesslessEngine, verifyReceipt } from '../src/index.ts';

test('all assigned queries return current, query-valid receipts', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export let value = 0; export const fn = (suffix: string) => `${value}:${suffix}`;',
	);
	engine.addFile(
		'consumer.ts',
		"import { value as alias } from './source.ts'; alias; alias++; alias += 2;",
	);
	engine.link();
	const value = engine.anchor('source.ts', 'value')!;
	const fn = engine.anchor('source.ts', 'fn')!;
	const receipts = [
		engine.definitionOf(value),
		engine.referencesOf(value),
		engine.readsOf(value),
		engine.writesOf(value),
		engine.exportedNames('source.ts'),
		engine.capturesOf(fn),
		engine.resolveBinding('source.ts', 'value'),
	];
	for (const receipt of receipts) {
		expect(receipt.state).toBe('complete');
		expect(engine.verify(receipt)).toBe(true);
	}
	expect(
		engine
			.referencesOf(value)
			.results.map((result) => result.access)
			.sort(),
	).toEqual(['read', 'read', 'read-write', 'read-write']);
	expect(engine.readsOf(value).results).toHaveLength(4);
	expect(engine.writesOf(value).results).toHaveLength(2);
	expect(engine.capturesOf(fn).results[0].symbol).toEqual(value);
	expect(engine.resolveBinding('source.ts', 'value').results).toEqual([value]);
});

test('namespace members classify reads, writes, updates, and compound assignments', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export let value = 0;');
	engine.addFile(
		'consumer.ts',
		"import * as ns from './source.ts'; ns.value; ns.value = 1; ns.value++; ns.value += 2;",
	);
	engine.link();
	const value = engine.anchor('source.ts', 'value')!;
	expect(
		engine
			.referencesOf(value)
			.results.map((result) => result.access)
			.sort(),
	).toEqual(['read', 'read-write', 'read-write', 'write']);
	expect(engine.readsOf(value).results).toHaveLength(3);
	expect(engine.writesOf(value).results).toHaveLength(3);
});

test('destructuring and for-in/of targets are writes for direct and namespace forms', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export let value = 0;');
	engine.addFile(
		'forms.ts',
		"import { value } from './source.ts'; import * as ns from './source.ts'; declare const obj: { value: number }; declare const xs: number[]; export const run = () => { ({ value } = obj); for (value of xs) void value; for (value in obj) void value; ({ value: ns.value } = obj); for (ns.value of xs) void ns.value; for (ns.value in obj) void ns.value; };",
	);
	engine.link();
	const receipt = engine.referencesOf(engine.anchor('source.ts', 'value')!);
	expect(receipt.results.map((result) => result.access).sort()).toEqual([
		'read',
		'read',
		'read',
		'read',
		'write',
		'write',
		'write',
		'write',
		'write',
		'write',
	]);
	expect(engine.writesOf(engine.anchor('source.ts', 'value')!).results).toHaveLength(6);
});

test('unresolved globals inside captures are named without collapsing identical sites', () => {
	const engine = new GuesslessEngine();
	engine.addFile('capture.ts', 'export const fn = () => missingGlobal + missingGlobal;');
	const receipt = engine.capturesOf(engine.anchor('capture.ts', 'fn')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected capture boundary');
	const sites = receipt.unresolved.filter((item) => item.reason === 'unresolved-symbol');
	expect(sites).toHaveLength(2);
	expect(new Set(sites.map((item) => JSON.stringify(item.site))).size).toBe(2);
	for (const item of sites) expect(engine.resolve(item.site)).not.toBeNull();
});

test('alias-mediated property mutation is uncertain, never guessed as a write', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'consumer.ts',
		"import { value } from './source.ts'; const alias = value; alias.x = 1;",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'value')!);
	expect(receipt.results).toEqual([]);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected alias uncertainty');
	expect(receipt.unresolved).toMatchObject([{ reason: 'property-alias-write-uncertain' }]);
});

test('transitive declaration and assignment aliases remain named uncertainty', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'consumer.ts',
		"import { value } from './source.ts'; const first = value; const second = first; let third; third = second; first.x = 1; second.x = 2; third.x = 3;",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'value')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected transitive alias uncertainty');
	expect(
		receipt.unresolved.filter((item) => item.reason === 'property-alias-write-uncertain'),
	).toHaveLength(3);
});

test('transparent JS and TS wrappers propagate declaration and assignment aliases', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'wrapped.ts',
		"import { value } from './source.ts'; const p = (value); const a = value as object; const t = <object>value; const s = value satisfies object; const n = value!; let ap, aa, at, sat, an; ap = (value); aa = value as object; at = <object>value; sat = value satisfies object; an = value!; p.x=1; a.x=1; t.x=1; s.x=1; n.x=1; ap.x=1; aa.x=1; at.x=1; sat.x=1; an.x=1;",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'value')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected wrapped alias uncertainty');
	expect(
		receipt.unresolved.filter((item) => item.reason === 'property-alias-write-uncertain'),
	).toHaveLength(10);
});

test('value-preserving and opaque expression flows fail closed at downstream mutations', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'flows.ts',
		"import { value } from './source.ts'; declare const fallback: typeof value; declare const flag: boolean; declare function opaque(input: typeof value): typeof value; declare function opaqueUnknown(input: unknown): typeof value; declare const Construct: new (input: typeof value) => typeof value; const sequence = (0, value); let assignedSequence; assignedSequence = (0, value); function defaulted(alias = value) { alias.x = 1; } const logical = value || fallback; const logicalRight = fallback || value; const conditional = flag ? value : fallback; let outer, inner; outer = inner = value; const { nested: destructured } = { nested: value }; let assignedDestructured; ({ nested: assignedDestructured } = { nested: value }); const [arrayDestructured] = [value]; let assignedArrayDestructured; [assignedArrayDestructured] = [value]; const { chosen = value } = {}; const called = opaque(value); const extracted = opaqueUnknown({ nested: value }); const constructed = new Construct(value); async function awaitedFlow() { const awaited = await opaque(value); awaited.x = 1; } sequence.x = 1; assignedSequence.x = 1; logical.x = 1; logicalRight.x = 1; conditional.x = 1; outer.x = 1; inner.x = 1; destructured.x = 1; assignedDestructured.x = 1; arrayDestructured.x = 1; assignedArrayDestructured.x = 1; chosen.x = 1; called.x = 1; extracted.x = 1; constructed.x = 1; void defaulted; void awaitedFlow;",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'value')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected conservative alias uncertainty');
	const gaps = receipt.unresolved.filter(
		(item) => item.reason === 'property-alias-write-uncertain',
	);
	expect(gaps).toHaveLength(17);
	expect(new Set(gaps.map((item) => JSON.stringify(item.site))).size).toBe(17);
	for (const gap of gaps) expect(engine.resolve(gap.site)).not.toBeNull();
});

test('aggregate containers are not mislabeled as aliases of their nested values', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'container.ts',
		"import { value } from './source.ts'; const container = { nested: value }; container.extra = 1;",
	);
	engine.link();
	expect(engine.writesOf(engine.anchor('source.ts', 'value')!)).toMatchObject({
		state: 'complete',
		results: [],
	});
});

test.each([
	['immediate object dot', 'const alias = ({ a: value }).a; alias.x = 1;', 1],
	['later object dot', 'const box = { a: value }; box.a.x = 1;', 1],
	['static object bracket', "const box = { a: value }; box['a'].x = 1;", 1],
	['nested aggregate', 'const box = { a: { b: value } }; box.a.b.x = 1;', 1],
	['immediate array index', 'const alias = [value][0]; alias.x = 1;', 1],
	['later array index', 'const items = [value]; items[0].x = 1;', 1],
	[
		'optional static extraction',
		'const box = { a: value }; const alias = box?.a; alias.x = 1;',
		1,
	],
	['object spread', 'const box = { a: value }; const copy = { ...box }; copy.a.x = 1;', 1],
	['array spread', 'const items = [value]; const copy = [...items]; copy[0].x = 1;', 1],
	['spread call argument', 'const alias = opaque(...[value]); alias.x = 1;', 1],
	['spread constructor argument', 'const alias = new Construct(...[value]); alias.x = 1;', 1],
	['tagged template result', 'const alias = tag`before ${value} after`; alias.x = 1;', 1],
	['object rest', 'const box = { a: value }; const { ...rest } = box; rest.a.x = 1;', 1],
	['array rest', 'const items = [0, value]; const [, ...rest] = items; rest[0].x = 1;', 1],
	['dynamic extraction', 'const box = { a: value }; const alias = box[key]; alias.x = 1;', 1],
	['dynamic storage', 'const box = { [key]: value }; box.a.x = 1;', 1],
	[
		'dynamic destructuring',
		'const box = { a: value }; const { [key]: alias } = box; alias.x = 1;',
		1,
	],
	['container-only negative', 'const box = { a: value }; box.extra = 1;', 0],
	['sibling negative', 'const box = { a: value, b: {} }; box.b.x = 1;', 0],
	[
		'rest exclusion negative',
		'const box = { a: value, b: {} }; const { a, ...rest } = box; rest.a.x = 1; void a;',
		0,
	],
])('aggregate/spread boundary: %s', (_name, body, expectedGaps) => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'boundary.ts',
		`import { value } from './source.ts'; declare const key: string; declare function opaque(...values: unknown[]): typeof value; declare const Construct: new (...values: unknown[]) => typeof value; declare function tag(strings: TemplateStringsArray, ...values: unknown[]): typeof value; ${body}`,
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'value')!);
	if (expectedGaps === 0) {
		expect(receipt).toMatchObject({ state: 'complete', results: [] });
		return;
	}
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected aggregate uncertainty');
	const gaps = receipt.unresolved.filter(
		(item) => item.reason === 'property-alias-write-uncertain',
	);
	expect(gaps).toHaveLength(expectedGaps);
	expect(new Set(gaps.map((item) => JSON.stringify(item.site))).size).toBe(expectedGaps);
	for (const gap of gaps) expect(engine.resolve(gap.site)).not.toBeNull();
	const expectedSiteSource = {
		'later object dot': 'box.a.x',
		'static object bracket': "box['a'].x",
		'nested aggregate': 'box.a.b.x',
		'dynamic extraction': 'box[key]',
		'dynamic storage': 'box.a.x',
	}[_name];
	if (expectedSiteSource !== undefined) {
		const node = engine.resolve(gaps[0].site) as { start: number; end: number };
		const module = engine.module('boundary.ts')!;
		expect(module.source.slice(node.start, node.end)).toBe(expectedSiteSource);
	}
});

test.each([
	[
		'named import alias',
		"import { aggregate as transported } from './source.ts'; transported.chosen.x = 1;",
		1,
		'transported.chosen.x',
	],
	[
		'default import',
		"import transported from './source.ts'; transported.chosen.x = 1;",
		1,
		'transported.chosen.x',
	],
	[
		'direct re-export',
		"import { renamedAggregate } from './barrel.ts'; renamedAggregate.chosen.x = 1;",
		1,
		'renamedAggregate.chosen.x',
	],
	[
		'export-star chain',
		"import { aggregate as transported } from './barrel.ts'; transported.chosen.x = 1;",
		1,
		'transported.chosen.x',
	],
	[
		'namespace import',
		"import * as ns from './barrel.ts'; ns.aggregate.chosen.x = 1;",
		1,
		'ns.aggregate.chosen.x',
	],
	[
		'namespace re-export alias',
		"import * as ns from './barrel.ts'; ns.renamedAggregate.chosen.x = 1;",
		1,
		'ns.renamedAggregate.chosen.x',
	],
	[
		'dynamic namespace extraction',
		"import * as ns from './barrel.ts'; declare const key: string; const selected = ns[key]; selected.x = 1;",
		1,
		'ns[key]',
	],
	[
		'transported container negative',
		"import { aggregate as transported } from './barrel.ts'; transported.extra = 1;",
		0,
		null,
	],
	[
		'transported sibling negative',
		"import { aggregate as transported } from './barrel.ts'; transported.sibling.x = 1;",
		0,
		null,
	],
])('cross-module aggregate boundary: %s', (_name, consumer, expectedGaps, expectedSource) => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target, sibling: {} }; export default aggregate;',
	);
	engine.addFile(
		'barrel.ts',
		"export { aggregate as renamedAggregate } from './source.ts'; export * from './source.ts';",
	);
	engine.addFile('consumer.ts', consumer);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	const gaps =
		receipt.state === 'partial'
			? receipt.unresolved.filter((item) => item.reason === 'property-alias-write-uncertain')
			: [];
	expect(gaps).toHaveLength(expectedGaps);
	if (expectedGaps === 0) expect(receipt).toMatchObject({ state: 'complete', results: [] });
	else {
		expect(receipt.state).toBe('partial');
		const node = engine.resolve(gaps[0].site) as { start: number; end: number };
		expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe(
			expectedSource,
		);
	}
});

test('cross-module namespace evidence follows identity through a renamed re-export', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export let target = 0;');
	engine.addFile('barrel.ts', "export { target as renamedTarget } from './source.ts';");
	engine.addFile('consumer.ts', "import * as ns from './barrel.ts'; ns.renamedTarget++;");
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt).toMatchObject({ state: 'complete', results: [{ access: 'read-write' }] });
	const node = engine.resolve(receipt.results[0].site) as { start: number; end: number };
	expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe('renamedTarget');
});

test('cross-module flow does not confuse same-spelled exports with symbol identity', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target };',
	);
	engine.addFile(
		'decoy.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target };',
	);
	engine.addFile(
		'consumer.ts',
		"import * as decoy from './decoy.ts'; decoy.aggregate.chosen.x = 1;",
	);
	engine.link();
	expect(engine.writesOf(engine.anchor('source.ts', 'target')!)).toMatchObject({
		state: 'complete',
		results: [],
	});
});

test('cross-module unresolved and external boundaries remain named', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target };',
	);
	engine.addFile(
		'consumer.ts',
		"import { aggregate } from './source.ts'; import type { External } from 'external-package'; import type { Missing } from './missing.ts'; aggregate.chosen.x = 1; void (0 as unknown as External); void (0 as unknown as Missing);",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected named module boundaries');
	expect(receipt.unresolved.map((item) => item.reason)).toEqual(
		expect.arrayContaining([
			'external-module-boundary',
			'unresolved-specifier',
			'property-alias-write-uncertain',
		]),
	);
	for (const item of receipt.unresolved) expect(engine.resolve(item.site)).not.toBeNull();
});

test.each([
	['direct default import', [], "import box from './source.ts'; box.chosen.x = 1;", 1],
	[
		'default re-export',
		["export { default } from './source.ts';"],
		"import box from './hop-0.ts'; box.chosen.x = 1;",
		1,
	],
	[
		'multi-hop default re-export',
		[
			"export { default } from './source.ts';",
			"export { default as default } from './hop-0.ts';",
		],
		"import box from './hop-1.ts'; box.chosen.x = 1;",
		1,
	],
	[
		'import then default export',
		["import box from './source.ts'; export default box;"],
		"import box from './hop-0.ts'; box.chosen.x = 1;",
		1,
	],
	[
		'anonymous sibling negative',
		["export { default } from './source.ts';"],
		"import box from './hop-0.ts'; box.sibling.x = 1;",
		0,
	],
])('anonymous default aggregate boundary: %s', (_name, hops, consumer, expectedGaps) => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export default { chosen: target, sibling: {} };',
	);
	for (const [index, source] of hops.entries()) engine.addFile(`hop-${index}.ts`, source);
	engine.addFile('consumer.ts', consumer);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	const gaps =
		receipt.state === 'partial'
			? receipt.unresolved.filter((item) => item.reason === 'property-alias-write-uncertain')
			: [];
	expect(gaps).toHaveLength(expectedGaps);
	if (expectedGaps === 0) expect(receipt).toMatchObject({ state: 'complete', results: [] });
	else {
		const node = engine.resolve(gaps[0].site) as { start: number; end: number };
		expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe(
			'box.chosen.x',
		);
	}
});

test('anonymous default flow uses export-record identity rather than spelling', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export default { chosen: target };',
	);
	engine.addFile(
		'decoy.ts',
		'export const target = { x: 0 }; export default { chosen: target };',
	);
	engine.addFile('consumer.ts', "import box from './decoy.ts'; box.chosen.x = 1;");
	engine.link();
	expect(engine.writesOf(engine.anchor('source.ts', 'target')!)).toMatchObject({
		state: 'complete',
		results: [],
	});
});

test('direct anonymous default expression survives a default re-export', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const target = { x: 0 }; export default target;');
	engine.addFile('barrel.ts', "export { default } from './source.ts';");
	engine.addFile('consumer.ts', "import value from './barrel.ts'; value.x = 1;");
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected default-expression uncertainty');
	const gap = receipt.unresolved.find(
		(item) => item.reason === 'property-alias-write-uncertain',
	)!;
	const node = engine.resolve(gap.site) as { start: number; end: number };
	expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe('value.x');
});

test('every unresolved export-from form is named alongside existing uncertainty', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target };',
	);
	engine.addFile(
		'barrel.ts',
		[
			"export { aggregate } from './source.ts';",
			"export * from './missing-star.ts';",
			"export { missing } from './missing-named.ts';",
			"export { default } from './missing-default.ts';",
			"export * as missingNamespace from './missing-namespace.ts';",
			"export * from 'external-export';",
			"export { default as builtinExport } from 'node:fs';",
		].join(' '),
	);
	engine.addFile(
		'consumer.ts',
		"import { aggregate } from './barrel.ts'; aggregate.chosen.x = 1;",
	);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected export boundaries');
	expect(receipt.unresolved.map((item) => item.reason)).toEqual(
		expect.arrayContaining([
			'property-alias-write-uncertain',
			'external-module-boundary',
			'builtin-module-boundary',
		]),
	);
	expect(
		receipt.unresolved.filter((item) => item.reason === 'unresolved-specifier'),
	).toHaveLength(4);
	expect(
		receipt.unresolved.filter((item) => item.reason === 'external-module-boundary'),
	).toHaveLength(1);
	expect(
		receipt.unresolved.filter((item) => item.reason === 'builtin-module-boundary'),
	).toHaveLength(1);
	expect(new Set(receipt.unresolved.map((item) => JSON.stringify(item.site))).size).toBe(
		receipt.unresolved.length,
	);
	for (const item of receipt.unresolved) expect(engine.resolve(item.site)).not.toBeNull();
});

test.each([
	[
		'named import anonymous default assignment',
		null,
		"import { bundle } from './barrel.ts'; bundle.default.chosen.x = 1;",
		'bundle.default.chosen.x',
	],
	[
		'namespace import anonymous default update',
		null,
		"import * as ns from './barrel.ts'; ns.bundle.default.chosen.x++;",
		'ns.bundle.default.chosen.x',
	],
	[
		'named export delete',
		null,
		"import { bundle } from './barrel.ts'; delete bundle.aggregate.chosen.x;",
		'bundle.aggregate.chosen.x',
	],
	[
		'named namespace re-export',
		"export { bundle as renamedBundle } from './barrel.ts';",
		"import { renamedBundle } from './bridge.ts'; renamedBundle.default.chosen.x = 1;",
		'renamedBundle.default.chosen.x',
	],
	[
		'multi-hop namespace-export chain',
		"export * as outer from './barrel.ts';",
		"import { outer } from './bridge.ts'; outer.bundle.default.chosen.x = 1;",
		'outer.bundle.default.chosen.x',
	],
	[
		'static destructuring',
		null,
		"import { bundle } from './barrel.ts'; const { default: selected } = bundle; selected.chosen.x = 1;",
		'selected.chosen.x',
	],
	[
		'namespace rest',
		null,
		"import { bundle } from './barrel.ts'; const { target: excluded, ...rest } = bundle; rest.default.chosen.x = 1; void excluded;",
		'rest.default.chosen.x',
	],
	[
		'namespace spread',
		null,
		"import { bundle } from './barrel.ts'; const spread = { ...bundle }; spread.default.chosen.x = 1;",
		'spread.default.chosen.x',
	],
	[
		'opaque selected export',
		null,
		"import { bundle } from './barrel.ts'; declare function opaque(value: unknown): typeof bundle.default.chosen; const selected = opaque(bundle.default.chosen); selected.x = 1;",
		'selected.x',
	],
	[
		'dynamic namespace selection',
		null,
		"import { bundle } from './barrel.ts'; declare const key: string; const selected = bundle[key]; selected.x = 1;",
		'bundle[key]',
	],
])('resolved namespace-export transport: %s', (_name, bridge, consumer, expectedSource) => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target, sibling: {} }; export default { chosen: target, sibling: {} };',
	);
	engine.addFile('barrel.ts', "export * as bundle from './source.ts';");
	if (bridge !== null) engine.addFile('bridge.ts', bridge);
	engine.addFile('consumer.ts', consumer);
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt.state).toBe('partial');
	if (receipt.state !== 'partial') throw new Error('expected namespace-export uncertainty');
	const gaps = receipt.unresolved.filter(
		(item) => item.reason === 'property-alias-write-uncertain',
	);
	expect(gaps).toHaveLength(1);
	const node = engine.resolve(gaps[0].site) as { start: number; end: number };
	expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe(expectedSource);
});

test.each([
	['namespace container', "import { bundle } from './barrel.ts'; bundle.extra = 1;"],
	['named sibling', "import { bundle } from './barrel.ts'; bundle.aggregate.sibling.x = 1;"],
	['anonymous sibling', "import { bundle } from './barrel.ts'; bundle.default.sibling.x = 1;"],
])('resolved namespace-export negative: %s', (_name, consumer) => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export const aggregate = { chosen: target, sibling: {} }; export default { chosen: target, sibling: {} };',
	);
	engine.addFile('barrel.ts', "export * as bundle from './source.ts';");
	engine.addFile('consumer.ts', consumer);
	engine.link();
	expect(engine.writesOf(engine.anchor('source.ts', 'target')!)).toMatchObject({
		state: 'complete',
		results: [],
	});
});

test('resolved namespace-export transport rejects a same-spelled foreign namespace', () => {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export const target = { x: 0 }; export default { chosen: target };',
	);
	engine.addFile(
		'decoy.ts',
		'export const target = { x: 0 }; export default { chosen: target };',
	);
	engine.addFile('source-barrel.ts', "export * as bundle from './source.ts';");
	engine.addFile('decoy-barrel.ts', "export * as bundle from './decoy.ts';");
	engine.addFile(
		'consumer.ts',
		"import { bundle } from './decoy-barrel.ts'; bundle.default.chosen.x = 1;",
	);
	engine.link();
	expect(engine.writesOf(engine.anchor('source.ts', 'target')!)).toMatchObject({
		state: 'complete',
		results: [],
	});
});

test('named namespace-export import proves a direct scalar update', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export let target = 0;');
	engine.addFile('barrel.ts', "export * as bundle from './source.ts';");
	engine.addFile('consumer.ts', "import { bundle } from './barrel.ts'; bundle.target++;");
	engine.link();
	const receipt = engine.writesOf(engine.anchor('source.ts', 'target')!);
	expect(receipt).toMatchObject({ state: 'complete', results: [{ access: 'read-write' }] });
	const node = engine.resolve(receipt.results[0].site) as { start: number; end: number };
	expect(engine.module('consumer.ts')!.source.slice(node.start, node.end)).toBe('target');
});

test('delete mutates alias and namespace members without false completeness', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = { x: 0 };');
	engine.addFile(
		'delete.ts',
		"import { value } from './source.ts'; import * as ns from './source.ts'; const alias = value; delete alias.x; delete ns.value;",
	);
	engine.link();
	const value = engine.anchor('source.ts', 'value')!;
	const writes = engine.writesOf(value);
	expect(writes.results.map((result) => result.access)).toEqual(['write']);
	expect(writes.state).toBe('partial');
	if (writes.state !== 'partial') throw new Error('expected alias delete uncertainty');
	expect(writes.unresolved).toMatchObject([{ reason: 'property-alias-write-uncertain' }]);
});

test('binding resolution uses a semantic site to select an inner shadowed scope', () => {
	const engine = new GuesslessEngine();
	const module = engine.addFile(
		'nested.ts',
		"export const value = 'outer'; export function nested() { const value = 'inner'; return value; }",
	);
	if (!('findAll' in module)) throw new Error('fixture must parse');
	const returnSite = anchorSite(module, module.findAll('ReturnStatement')[0], 'binding-scope');
	const inner = module.symbols.find(
		(symbol) => symbol.name === 'value' && symbol.scope.kind !== 'module',
	)!;
	const receipt = engine.resolveBinding('nested.ts', 'value', 'value', returnSite);
	expect(receipt.results).toEqual([anchorSymbol(inner)]);
	expect(receipt.request).toEqual({
		kind: 'resolveBinding',
		file: 'nested.ts',
		name: 'value',
		space: 'value',
		scope: returnSite,
	});
	expect(engine.resolve(returnSite)).not.toBeNull();
});

test('signed requests distinguish targets within one snapshot and reject substitution', () => {
	const engine = new GuesslessEngine();
	engine.addFile('ids.ts', 'export const first = 1; export const second = 2; first; second;');
	const first = engine.referencesOf(engine.anchor('ids.ts', 'first')!);
	const second = engine.referencesOf(engine.anchor('ids.ts', 'second')!);
	expect(first.snapshot).toBe(second.snapshot);
	expect(first.request).not.toEqual(second.request);
	expect(first.integrity).not.toBe(second.integrity);
	expect(verifyReceipt({ ...first, request: second.request }, first.snapshot)).toBe(false);
});

test('binding resolution refuses foreign-module scope anchors', () => {
	const engine = new GuesslessEngine();
	engine.addFile('requested.ts', "export const value = 'requested';");
	const foreign = engine.addFile(
		'foreign.ts',
		"export const value = 'foreign'; export const use = () => value;",
	);
	if (!('findAll' in foreign)) throw new Error('fixture must parse');
	const foreignSite = anchorSite(
		foreign,
		foreign.findAll('ArrowFunctionExpression')[0],
		'foreign-scope',
	);
	const receipt = engine.resolveBinding('requested.ts', 'value', 'value', foreignSite);
	expect(receipt).toMatchObject({ state: 'refused', reason: 'unresolved-symbol', results: [] });
	expect(receipt.request).toMatchObject({ file: 'requested.ts', scope: foreignSite });
});

test('binding resolution refuses a resolver result outside the requested module', () => {
	const engine = new GuesslessEngine();
	engine.addFile('requested.ts', "export const value = 'requested';");
	const foreign = engine.addFile('foreign.ts', "export const value = 'foreign';");
	if (!('symbols' in foreign)) throw new Error('fixture must parse');
	engine.link();
	const requested = engine.module('requested.ts')!;
	const foreignValue = foreign.symbols.find((symbol) => symbol.name === 'value')!;
	Object.defineProperty(requested, 'resolve', {
		configurable: true,
		value: () => foreignValue,
	});
	const receipt = engine.resolveBinding('requested.ts', 'value');
	expect(receipt).toMatchObject({ state: 'refused', reason: 'unresolved-symbol', results: [] });
	expect(receipt.results).not.toContainEqual(anchorSymbol(foreignValue));
});

test('unsupported languages and stale anchors are refused', () => {
	const engine = new GuesslessEngine();
	expect(engine.addFile('thing.py', 'x = 1')).toMatchObject({
		state: 'refused',
		reason: 'unsupported-language',
	});
	engine.addFile('a.ts', 'const value = 1;');
	const anchor = engine.anchor('a.ts', 'value')!;
	engine.addFile('a.ts', 'const value = 2;');
	expect(engine.referencesOf(anchor)).toMatchObject({
		state: 'refused',
		reason: 'unresolved-symbol',
	});
});
