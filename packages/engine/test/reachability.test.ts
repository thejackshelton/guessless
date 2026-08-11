import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { GuesslessEngine, type ReachabilityResult, type SymbolAnchor } from '../src/index.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/adversarial');
const fixtureNames = [
	'definitions.ts',
	'higher-order.ts',
	'reachability-leaf.ts',
	'reachability-middle.ts',
	'reachability-boundaries.ts',
	'reachability-cycle.ts',
	'reachability-entry.ts',
] as const;

function fixtureEngine(): GuesslessEngine {
	const engine = new GuesslessEngine();
	for (const name of fixtureNames)
		engine.addFile(name, readFileSync(join(fixtureDir, name), 'utf8'));
	engine.link();
	return engine;
}

function symbolIdentity(anchor: SymbolAnchor): string {
	return `${anchor.file}:${anchor.semanticPath.find((part) => part.startsWith('symbol:'))}`;
}

function assertExactReachability(
	engine: GuesslessEngine,
	results: readonly ReachabilityResult[],
	expected: string[],
): void {
	expect(results.map((result) => symbolIdentity(result.symbol))).toEqual(expected);
	expect(new Set(results.map((result) => JSON.stringify(result.symbol))).size).toBe(
		results.length,
	);
	for (const result of results) {
		expect(engine.resolve(result.symbol)).not.toBeNull();
		expect(result.witness.length).toBeGreaterThan(0);
		for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
	}
}

describe('reachableFrom', () => {
	test('returns deterministic transitive dependencies through aliases, imports, and namespaces', () => {
		const engine = fixtureEngine();
		const entry = engine.anchor('reachability-entry.ts', 'dependencyEntry')!;
		const receipt = engine.reachableFrom(entry);
		expect(receipt.state).toBe('complete');
		expect(engine.verify(receipt)).toBe(true);
		assertExactReachability(engine, receipt.results, [
			'reachability-entry.ts:symbol:leafNamespace',
			'reachability-leaf.ts:symbol:leaf',
			'reachability-leaf.ts:symbol:leafValue',
			'reachability-middle.ts:symbol:wrapper',
			'reachability-middle.ts:symbol:wrapperAlias',
		]);
		expect(engine.reachableFrom(entry)).toEqual(receipt);
	});

	test('refuses a stale target without unsigned fallback results', () => {
		const engine = fixtureEngine();
		const entry = engine.anchor('reachability-entry.ts', 'dependencyEntry')!;
		engine.removeFile('reachability-entry.ts');
		engine.link();
		expect(engine.reachableFrom(entry)).toMatchObject({
			state: 'refused',
			reason: 'unresolved-symbol',
			results: [],
		});
	});
});

describe('reaches', () => {
	test('proves exact array and object destructured undefined aliases only', () => {
		const engine = new GuesslessEngine();
		engine.addFile('pattern-import.ts', 'export declare const imported: unknown;');
		engine.addFile(
			'pattern-undefined.ts',
			[
				"import { imported } from './pattern-import.ts';",
				'function leaf(): void {}',
				'function invoke(callback: () => void = leaf): void { callback(); }',
				'const [arrayValue] = [undefined];',
				'const { nested: { value: objectValue } } = { nested: { value: void 0 } };',
				'let [mutableValue] = [undefined];',
				'const [sparseValue] = [,];',
				'const [...restValue] = [undefined];',
				"const key = 'value';",
				'const { [key]: computedValue } = { value: undefined };',
				'const [importedValue] = [imported];',
				'const [cycleValue] = cycleSource;',
				'const cycleSource = [cycleValue];',
				'export function arrayEntry(): void { invoke(arrayValue); }',
				'export function objectEntry(): void { invoke(objectValue); }',
				'export function mutableEntry(): void { invoke(mutableValue); }',
				'export function sparseEntry(): void { invoke(sparseValue); }',
				'export function restEntry(): void { invoke(restValue[0]); }',
				'export function computedEntry(): void { invoke(computedValue); }',
				'export function importedEntry(): void { invoke(importedValue); }',
				'export function cycleEntry(): void { invoke(cycleValue); }',
			].join('\n'),
		);
		engine.link();
		for (const name of ['arrayEntry', 'objectEntry']) {
			const receipt = engine.reaches(engine.anchor('pattern-undefined.ts', name)!);
			expect(receipt.state, name).toBe('complete');
			expect(
				receipt.results.map((result) => symbolIdentity(result.symbol)),
				name,
			).toEqual(['pattern-undefined.ts:symbol:invoke', 'pattern-undefined.ts:symbol:leaf']);
		}
		for (const name of [
			'mutableEntry',
			'sparseEntry',
			'restEntry',
			'computedEntry',
			'importedEntry',
			'cycleEntry',
		]) {
			const receipt = engine.reaches(engine.anchor('pattern-undefined.ts', name)!);
			expect(receipt.state, name).toBe('partial');
			if (receipt.state !== 'partial') throw new Error(`expected ${name} uncertainty`);
			expect(
				receipt.unresolved.map((gap) => gap.reason),
				name,
			).toContain('higher-order-call-boundary');
		}
	});

	test('normalizes template and signed accessor keys and exposes unknown declarations', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-static-keys.ts',
			[
				'function templateLeaf(): number { return 1; }',
				'function signedLeaf(): number { return 1; }',
				'function primitiveLeaf(): number { return 1; }',
				'let unknownKey = "unknown";',
				'class Known {',
				'  get [`template`](): number { return templateLeaf(); }',
				'  get [-1](): number { return signedLeaf(); }',
				'  get [true](): number { return primitiveLeaf(); }',
				'  get [unknownKey](): number { return 1; }',
				'}',
				'export function complete(): void {',
				'  const item = new Known();',
				'  item[`template`];',
				'  item[-1];',
				'  item[true];',
				'}',
				'export function uncertain(): void { const item = new Known(); item.missing; }',
			].join('\n'),
		);
		engine.link();
		const complete = engine.reaches(engine.anchor('accessor-static-keys.ts', 'complete')!);
		expect(complete.state).toBe('complete');
		assertExactReachability(engine, complete.results, [
			'accessor-static-keys.ts:symbol:Known',
			'accessor-static-keys.ts:symbol:primitiveLeaf',
			'accessor-static-keys.ts:symbol:signedLeaf',
			'accessor-static-keys.ts:symbol:templateLeaf',
		]);
		const uncertain = engine.reaches(engine.anchor('accessor-static-keys.ts', 'uncertain')!);
		expect(uncertain.state).toBe('partial');
		if (uncertain.state !== 'partial') throw new Error('expected accessor declaration gap');
		expect(uncertain.unresolved.map((gap) => gap.reason)).toEqual(['linked-set-boundary']);
		expect(engine.resolve(uncertain.unresolved[0]!.site)).not.toBeNull();
	});

	test('executes nested parameter, constructor, declaration, assignment, and loop patterns', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'executable-patterns.ts',
			[
				'function directLeaf(): number { return 1; }',
				'function arrowLeaf(): number { return 1; }',
				'function transportLeaf(): number { return 1; }',
				'function nestedLeaf(): number { return 1; }',
				'function constructLeaf(): number { return 1; }',
				'function implicitLeaf(): number { return 1; }',
				'function methodLeaf(): number { return 1; }',
				'function declaredLeaf(): number { return 1; }',
				'function assignedLeaf(): number { return 1; }',
				'function loopLeaf(): number { return 1; }',
				'class Source {',
				'  get direct(): number { return directLeaf(); }',
				'  get arrow(): number { return arrowLeaf(); }',
				'  get transport(): number { return transportLeaf(); }',
				'  get nested(): number { return nestedLeaf(); }',
				'  get construct(): number { return constructLeaf(); }',
				'  get implicit(): number { return implicitLeaf(); }',
				'  get method(): number { return methodLeaf(); }',
				'  get declared(): number { return declaredLeaf(); }',
				'  get assigned(): number { return assignedLeaf(); }',
				'  get looped(): number { return loopLeaf(); }',
				'}',
				'function direct({ direct }: Source): void {}',
				'const arrow = ([{ arrow }]: [Source]): void => {};',
				'function transported(item: Source): void { item.transport; }',
				'function nested({ holder }: { holder: Source }): void { holder.nested; }',
				'class Consumer {',
				'  constructor({ holder: { construct } }: { holder: Source }) {}',
				'  consume({ method }: Source): void {}',
				'}',
				'class PatternBase { constructor({ implicit }: Source) {} }',
				'class PatternDerived extends PatternBase {}',
				'export function entry(): void {',
				'  const item = new Source();',
				'  direct(item);',
				'  arrow([item]);',
				'  transported(item);',
				'  nested({ holder: item });',
				'  const consumer = new Consumer({ holder: item });',
				'  consumer.consume(item);',
				'  new PatternDerived(item);',
				'  const { declared } = item;',
				'  let assigned = 0;',
				'  ({ assigned } = item);',
				'  for (const { looped } of [item]) void looped;',
				'}',
				'export function uncertain(iterable: unknown, receiver: unknown): void {',
				'  for (const { value } of iterable) void value;',
				'  for (const key in receiver) void key;',
				'  const { child: { value } } = receiver;',
				'}',
				'export function omitted(): void { direct(); }',
			].join('\n'),
		);
		engine.link();
		const complete = engine.reaches(engine.anchor('executable-patterns.ts', 'entry')!);
		expect(complete.state).toBe('complete');
		expect(complete.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'executable-patterns.ts:symbol:Consumer',
				'executable-patterns.ts:symbol:Source',
				'executable-patterns.ts:symbol:arrow',
				'executable-patterns.ts:symbol:arrowLeaf',
				'executable-patterns.ts:symbol:assignedLeaf',
				'executable-patterns.ts:symbol:constructLeaf',
				'executable-patterns.ts:symbol:declaredLeaf',
				'executable-patterns.ts:symbol:direct',
				'executable-patterns.ts:symbol:directLeaf',
				'executable-patterns.ts:symbol:implicitLeaf',
				'executable-patterns.ts:symbol:loopLeaf',
				'executable-patterns.ts:symbol:methodLeaf',
				'executable-patterns.ts:symbol:nested',
				'executable-patterns.ts:symbol:nestedLeaf',
				'executable-patterns.ts:symbol:PatternBase',
				'executable-patterns.ts:symbol:PatternDerived',
				'executable-patterns.ts:symbol:transportLeaf',
				'executable-patterns.ts:symbol:transported',
			]),
		);
		for (const result of complete.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		expect(engine.verify(complete)).toBe(true);
		const uncertain = engine.reaches(engine.anchor('executable-patterns.ts', 'uncertain')!);
		expect(uncertain.state).toBe('partial');
		if (uncertain.state !== 'partial') throw new Error('expected executable pattern gaps');
		expect(uncertain.unresolved.length).toBeGreaterThanOrEqual(4);
		for (const gap of uncertain.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		const omitted = engine.reaches(engine.anchor('executable-patterns.ts', 'omitted')!);
		expect(omitted.state).toBe('partial');
		if (omitted.state !== 'partial') throw new Error('expected omitted pattern gap');
		expect(omitted.unresolved.map((gap) => gap.reason)).toContain('linked-set-boundary');
		engine.addFile('executable-patterns-added.ts', 'export const added = true;');
		engine.link();
		expect(engine.verify(complete)).toBe(false);
	});

	test('selects defaults through immutable undefined aliases and rejects uncertain aliases', () => {
		const engine = new GuesslessEngine();
		engine.addFile('undefined-import.ts', 'export declare const imported: unknown;');
		engine.addFile(
			'undefined-aliases.ts',
			[
				"import { imported } from './undefined-import.ts';",
				'function leaf(): void {}',
				'function invoke(callback: () => void = leaf): void { callback(); }',
				'const direct = undefined;',
				'const wrapped = (direct as undefined)!;',
				'const chained = wrapped;',
				'let mutable = undefined;',
				'const importedAlias = imported;',
				'const cycleA = cycleB;',
				'const cycleB = cycleA;',
				'function shadowed(undefined: unknown): void { const alias = undefined; invoke(alias); }',
				'export function directEntry(): void { invoke(direct); }',
				'export function wrappedEntry(): void { invoke(chained); }',
				'export function mutableEntry(): void { invoke(mutable); }',
				'export function importedEntry(): void { invoke(importedAlias); }',
				'export function cycleEntry(): void { invoke(cycleA); }',
				'export function shadowedEntry(value: unknown): void { shadowed(value); }',
			].join('\n'),
		);
		engine.link();
		for (const name of ['directEntry', 'wrappedEntry']) {
			const receipt = engine.reaches(engine.anchor('undefined-aliases.ts', name)!);
			expect(receipt.state, name).toBe('complete');
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual([
				'undefined-aliases.ts:symbol:invoke',
				'undefined-aliases.ts:symbol:leaf',
			]);
		}
		for (const name of ['mutableEntry', 'importedEntry', 'cycleEntry', 'shadowedEntry']) {
			const receipt = engine.reaches(engine.anchor('undefined-aliases.ts', name)!);
			expect(receipt.state, name).toBe('partial');
			if (receipt.state !== 'partial') throw new Error(`expected ${name} boundary`);
			expect(
				receipt.unresolved.map((gap) => gap.reason),
				name,
			).toContain('higher-order-call-boundary');
			for (const gap of receipt.unresolved)
				expect(engine.resolve(gap.site), name).not.toBeNull();
		}
	});

	test('canonicalizes literal, computed, numeric, private, and super accessor keys', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-canonical-base.ts',
			[
				"const COMPUTED = 'computed' as const;",
				'export function plainLeaf(): number { return 1; }',
				'export function literalLeaf(): number { return 1; }',
				'export function numericLeaf(): number { return 1; }',
				'export function computedLeaf(): number { return 1; }',
				'export function privateLeaf(): number { return 1; }',
				'export function staticLeaf(): number { return 1; }',
				'export class Base {',
				'  get plain(): number { return plainLeaf(); }',
				'  get "literal"(): number { return literalLeaf(); }',
				'  get 1(): number { return numericLeaf(); }',
				'  get [COMPUTED](): number { return computedLeaf(); }',
				'  get #secret(): number { return privateLeaf(); }',
				'  static get staticValue(): number { return staticLeaf(); }',
				'  static get staticAlias(): number { return this.staticValue; }',
				'  privateCopy = this.#secret;',
				'}',
			].join('\n'),
		);
		engine.addFile(
			'accessor-canonical-derived.ts',
			[
				"import { Base } from './accessor-canonical-base.ts';",
				'export class Derived extends Base { superCopy = super.plain; }',
			].join('\n'),
		);
		engine.addFile(
			'accessor-canonical-entry.ts',
			[
				"import { Derived } from './accessor-canonical-derived.ts';",
				"const key = 'computed' as const;",
				'export function entry(): void {',
				'  const item = new Derived();',
				'  item.plain;',
				'  item["literal"];',
				'  item[1];',
				'  item[key];',
				'  Derived.staticAlias;',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('accessor-canonical-entry.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'accessor-canonical-base.ts:symbol:Base',
				'accessor-canonical-base.ts:symbol:plainLeaf',
				'accessor-canonical-base.ts:symbol:literalLeaf',
				'accessor-canonical-base.ts:symbol:numericLeaf',
				'accessor-canonical-base.ts:symbol:computedLeaf',
				'accessor-canonical-base.ts:symbol:privateLeaf',
				'accessor-canonical-base.ts:symbol:staticLeaf',
				'accessor-canonical-derived.ts:symbol:Derived',
			]),
		);
		expect(receipt.results).toHaveLength(8);
		for (const result of receipt.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		expect(engine.verify(receipt)).toBe(true);
		engine.addFile('accessor-canonical-added.ts', 'export const added = true;');
		engine.link();
		expect(engine.verify(receipt)).toBe(false);
	});

	test('accounts for declaration and assignment destructuring getters and setter updates', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-destructuring.ts',
			[
				'function alphaLeaf(): number { return 1; }',
				'function betaLeaf(): number { return 1; }',
				'function setterLeaf(): void {}',
				'class Known {',
				'  get alpha(): number { return alphaLeaf(); }',
				'  set alpha(value: number) { setterLeaf(); }',
				'  get "beta"(): number { return betaLeaf(); }',
				'}',
				'export function entry(): void {',
				'  const item = new Known();',
				'  const { alpha, ["beta"]: beta } = item;',
				'  let assigned = 0;',
				'  ({ alpha: assigned } = item);',
				'  item.alpha = 2;',
				'  item.alpha++;',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('accessor-destructuring.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, [
			'accessor-destructuring.ts:symbol:alphaLeaf',
			'accessor-destructuring.ts:symbol:betaLeaf',
			'accessor-destructuring.ts:symbol:Known',
			'accessor-destructuring.ts:symbol:setterLeaf',
		]);
	});

	test('fails closed for destructuring rest, spread, unknown keys, and unknown receivers', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-pattern-boundaries.ts',
			[
				'class Known { get alpha(): number { return 1; } }',
				'export function boundary(receiver: unknown, key: string): void {',
				'  const item = new Known();',
				'  const { [key]: dynamic, ...rest } = item;',
				'  const copied = { ...item };',
				'  const { alpha } = receiver;',
				'}',
				'class Cycle { get first(): number { return this.second; } get second(): number { return this.first; } }',
				'export function cycle(): void { new Cycle().first; }',
			].join('\n'),
		);
		engine.link();
		const boundary = engine.reaches(
			engine.anchor('accessor-pattern-boundaries.ts', 'boundary')!,
		);
		expect(boundary.state).toBe('partial');
		if (boundary.state !== 'partial') throw new Error('expected pattern boundaries');
		expect(boundary.unresolved.map((gap) => gap.reason).sort()).toEqual([
			'dynamic-member-access',
			'dynamic-member-access',
			'dynamic-member-access',
			'linked-set-boundary',
		]);
		for (const gap of boundary.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		const cycle = engine.reaches(engine.anchor('accessor-pattern-boundaries.ts', 'cycle')!);
		expect(cycle.state).toBe('complete');
		assertExactReachability(engine, cycle.results, [
			'accessor-pattern-boundaries.ts:symbol:Cycle',
		]);
	});

	test('selects callable defaults only for omitted or statically undefined arguments', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'defaults.ts',
			[
				'function defaultLeaf(): void {}',
				'function shadowLeaf(): void {}',
				'function invoke(callback: () => void = defaultLeaf): void { callback(); }',
				'function shadowed(undefined: () => void = shadowLeaf): void { invoke(undefined); }',
				'export function omitted(): void { invoke(); }',
				'export function unshadowed(): void { invoke(undefined); }',
				'export function voided(): void { invoke(void shadowLeaf); }',
				'export function shadowedEntry(): void { shadowed(); }',
				'export function uncertain(value: unknown): void { invoke(value); }',
			].join('\n'),
		);
		engine.link();
		for (const name of ['omitted', 'unshadowed', 'voided']) {
			const receipt = engine.reaches(engine.anchor('defaults.ts', name)!);
			expect(receipt.state, name).toBe('complete');
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual([
				'defaults.ts:symbol:defaultLeaf',
				'defaults.ts:symbol:invoke',
			]);
		}
		const shadowed = engine.reaches(engine.anchor('defaults.ts', 'shadowedEntry')!);
		expect(shadowed.state).toBe('complete');
		expect(shadowed.results.map((result) => symbolIdentity(result.symbol))).toEqual([
			'defaults.ts:symbol:invoke',
			'defaults.ts:symbol:shadowed',
			'defaults.ts:symbol:shadowLeaf',
		]);
		expect(shadowed.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
			'defaults.ts:symbol:defaultLeaf',
		);
		const uncertain = engine.reaches(engine.anchor('defaults.ts', 'uncertain')!);
		expect(uncertain.state).toBe('partial');
		if (uncertain.state !== 'partial') throw new Error('expected uncertain default boundary');
		expect(uncertain.unresolved.map((gap) => gap.reason)).toEqual([
			'higher-order-call-boundary',
		]);
	});

	test('separates invalid class calls from valid class and function construction', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'invocation-mode.ts',
			[
				'function fieldLeaf(): number { return 1; }',
				'function constructorLeaf(): void {}',
				'function functionLeaf(): void {}',
				'class Example { value = fieldLeaf(); constructor() { constructorLeaf(); } }',
				'function Constructable(): void { functionLeaf(); }',
				'export function invalidCall(): void { Example(); }',
				'export function validClassNew(): void { new Example(); }',
				'export function validFunctionNew(): void { new Constructable(); }',
			].join('\n'),
		);
		engine.link();
		const invalid = engine.reaches(engine.anchor('invocation-mode.ts', 'invalidCall')!);
		expect(invalid.state).toBe('partial');
		assertExactReachability(engine, invalid.results, ['invocation-mode.ts:symbol:Example']);
		if (invalid.state !== 'partial') throw new Error('expected invalid class call boundary');
		expect(invalid.unresolved.map((gap) => gap.reason)).toEqual(['unsupported-syntax']);
		expect(engine.resolve(invalid.unresolved[0]!.site)).not.toBeNull();
		const classNew = engine.reaches(engine.anchor('invocation-mode.ts', 'validClassNew')!);
		expect(classNew.state).toBe('complete');
		expect(classNew.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'invocation-mode.ts:symbol:Example',
				'invocation-mode.ts:symbol:constructorLeaf',
				'invocation-mode.ts:symbol:fieldLeaf',
			]),
		);
		const functionNew = engine.reaches(
			engine.anchor('invocation-mode.ts', 'validFunctionNew')!,
		);
		expect(functionNew.state).toBe('complete');
		expect(functionNew.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'invocation-mode.ts:symbol:Constructable',
				'invocation-mode.ts:symbol:functionLeaf',
			]),
		);
	});

	test('traverses inherited cross-module getter and setter bodies with exact witnesses', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-base.ts',
			[
				'export function getterLeaf(): number { return 1; }',
				'export function setterLeaf(): void {}',
				'export class Base {',
				'  get value(): number { return getterLeaf(); }',
				'  set value(next: number) { setterLeaf(); }',
				'}',
			].join('\n'),
		);
		engine.addFile('accessor-barrel.ts', "export * as models from './accessor-base.ts';");
		engine.addFile(
			'accessor-derived.ts',
			[
				"import { models } from './accessor-barrel.ts';",
				'export class Derived extends models.Base {',
				'  copied = this.value;',
				'  constructor() { super(); this.value = 2; }',
				'}',
			].join('\n'),
		);
		engine.addFile(
			'accessor-entry.ts',
			[
				"import { Derived } from './accessor-derived.ts';",
				'export function entry(): void {',
				'  const instance = new Derived();',
				'  instance.value;',
				'  instance.value = 2;',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('accessor-entry.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'accessor-base.ts:symbol:Base',
				'accessor-base.ts:symbol:getterLeaf',
				'accessor-base.ts:symbol:setterLeaf',
				'accessor-derived.ts:symbol:Derived',
			]),
		);
		expect(receipt.results).toHaveLength(4);
		for (const result of receipt.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		expect(engine.verify(receipt)).toBe(true);
		engine.addFile('accessor-added.ts', 'export const added = true;');
		engine.link();
		expect(engine.verify(receipt)).toBe(false);
	});

	test('fails closed for dynamic or unproven accessor receivers without guessing proxies', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'accessor-boundaries.ts',
			[
				'class Known { data = 1; get value(): number { return 1; } }',
				'export function known(): void { const item = new Known(); item.data; }',
				'export function computed(): void { const item = new Known(); item["value"]; }',
				'export function unknown(receiver: unknown): void { receiver.value; receiver.value = 1; }',
			].join('\n'),
		);
		engine.link();
		expect(engine.reaches(engine.anchor('accessor-boundaries.ts', 'known')!).state).toBe(
			'complete',
		);
		const computed = engine.reaches(engine.anchor('accessor-boundaries.ts', 'computed')!);
		expect(computed.state).toBe('complete');
		const unknown = engine.reaches(engine.anchor('accessor-boundaries.ts', 'unknown')!);
		expect(unknown.state).toBe('partial');
		if (unknown.state !== 'partial') throw new Error('expected receiver boundaries');
		expect(unknown.unresolved.map((gap) => gap.reason)).toEqual([
			'linked-set-boundary',
			'linked-set-boundary',
		]);
		for (const gap of unknown.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
	});

	test('uses callable defaults and rejects unproven invoked-parameter bindings', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'bindings.ts',
			[
				'function leaf(): void {}',
				'function withDefault(callback: () => void = leaf): void { callback(); }',
				'function invoke(callback: () => void): void { callback(); }',
				'function destructured({ callback }: { callback: () => void }): void { callback(); }',
				'function rest(...callbacks: Array<() => void>): void { callbacks(); }',
				'export function defaultEntry(): void { withDefault(); }',
				'export function omittedEntry(): void { invoke(); }',
				'export function nonCallableEntry(): void { invoke(0); }',
				'export function spreadEntry(): void { invoke(...[leaf]); }',
				'export function destructuredEntry(): void { destructured({ callback: leaf }); }',
				'export function restEntry(): void { rest(leaf); }',
				'export function localEntry(): void { const value = 1; value(); }',
			].join('\n'),
		);
		engine.link();
		const defaultReceipt = engine.reaches(engine.anchor('bindings.ts', 'defaultEntry')!);
		expect(defaultReceipt.state).toBe('complete');
		assertExactReachability(engine, defaultReceipt.results, [
			'bindings.ts:symbol:leaf',
			'bindings.ts:symbol:withDefault',
		]);
		const leaf = defaultReceipt.results.find(
			(result) => symbolIdentity(result.symbol) === 'bindings.ts:symbol:leaf',
		)!;
		expect(leaf.witness).toHaveLength(3);
		for (const name of [
			'omittedEntry',
			'nonCallableEntry',
			'spreadEntry',
			'destructuredEntry',
			'restEntry',
		]) {
			const receipt = engine.reaches(engine.anchor('bindings.ts', name)!);
			expect(receipt.state, name).toBe('partial');
			if (receipt.state !== 'partial') throw new Error(`expected ${name} boundary`);
			expect(
				receipt.unresolved.some((gap) => gap.reason === 'higher-order-call-boundary'),
				name,
			).toBe(true);
			for (const gap of receipt.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
				'bindings.ts:symbol:callback',
			);
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
				'bindings.ts:symbol:callbacks',
			);
		}
		const local = engine.reaches(engine.anchor('bindings.ts', 'localEntry')!);
		expect(local.state).toBe('partial');
		expect(local.results).toEqual([]);
		if (local.state !== 'partial') throw new Error('expected non-callable local boundary');
		expect(local.unresolved.map((gap) => gap.reason)).toEqual(['unresolved-symbol']);
		expect(engine.resolve(local.unresolved[0]!.site)).not.toBeNull();
	});

	test('executes class fields, explicit and implicit constructors, and base chains by identity', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'base.ts',
			[
				'export function baseFieldLeaf(): number { return 1; }',
				'export function baseConstructorLeaf(): void {}',
				'export class Base {',
				'  value = baseFieldLeaf();',
				'  constructor() { baseConstructorLeaf(); }',
				'}',
			].join('\n'),
		);
		engine.addFile('barrel.ts', "export { Base as RenamedBase } from './base.ts';");
		engine.addFile(
			'derived.ts',
			[
				"import * as models from './barrel.ts';",
				'const BaseAlias = models.RenamedBase;',
				'export function derivedFieldLeaf(): number { return 1; }',
				'export function derivedConstructorLeaf(): void {}',
				'export class Derived extends BaseAlias {',
				'  value = derivedFieldLeaf();',
				'  constructor() { super(); derivedConstructorLeaf(); }',
				'}',
			].join('\n'),
		);
		engine.addFile(
			'entry.ts',
			[
				"import { Derived as DerivedAlias } from './derived.ts';",
				'class Implicit extends DerivedAlias {}',
				'export function entry(): void { new Implicit(); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('entry.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'base.ts:symbol:Base',
				'base.ts:symbol:baseConstructorLeaf',
				'base.ts:symbol:baseFieldLeaf',
				'derived.ts:symbol:Derived',
				'derived.ts:symbol:derivedConstructorLeaf',
				'derived.ts:symbol:derivedFieldLeaf',
				'entry.ts:symbol:Implicit',
			]),
		);
		expect(receipt.results).toHaveLength(7);
		for (const result of receipt.results) {
			expect(result.witness.length).toBeGreaterThan(0);
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		}
		expect(engine.verify(receipt)).toBe(true);
		engine.addFile('construction-added.ts', 'export const added = true;');
		engine.link();
		expect(engine.verify(receipt)).toBe(false);
	});

	test('does not execute function-valued fields until invoked and terminates class cycles', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'classes.ts',
			[
				'function hiddenLeaf(): void {}',
				'class A extends B { handler = () => hiddenLeaf(); }',
				'class B extends A {}',
				'export function entry(): void { new A(); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('classes.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, [
			'classes.ts:symbol:A',
			'classes.ts:symbol:B',
		]);
		expect(engine.reaches(engine.anchor('classes.ts', 'entry')!)).toEqual(receipt);
	});

	test('forwards callable arguments through an implicit derived constructor', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'implicit.ts',
			[
				'function leaf(): void {}',
				'class Base { constructor(callback: () => void) { callback(); } }',
				'class Derived extends Base {}',
				'export function entry(): void { new Derived(leaf); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('implicit.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, [
			'implicit.ts:symbol:Base',
			'implicit.ts:symbol:Derived',
			'implicit.ts:symbol:leaf',
		]);
		const leaf = receipt.results.find(
			(result) => symbolIdentity(result.symbol) === 'implicit.ts:symbol:leaf',
		)!;
		expect(leaf.witness).toHaveLength(3);
	});

	test('reports JSX class identity without assuming constructor, field, or render execution', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'class-component.tsx',
			[
				'function hiddenLeaf(): number { return 1; }',
				'class Component {',
				'  value = hiddenLeaf();',
				'  render() { return <section />; }',
				'}',
				'export function entry() { return <Component />; }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('class-component.tsx', 'entry')!);
		expect(receipt.state).toBe('partial');
		assertExactReachability(engine, receipt.results, ['class-component.tsx:symbol:Component']);
		if (receipt.state !== 'partial') throw new Error('expected JSX class boundary');
		expect(receipt.unresolved.map((gap) => gap.reason)).toEqual(['linked-set-boundary']);
		expect(engine.resolve(receipt.unresolved[0]!.site)).not.toBeNull();
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
			'class-component.tsx:symbol:hiddenLeaf',
		);
	});

	test('forwards callable bindings through aliases, re-exports, namespaces, and multiple hops', () => {
		const engine = new GuesslessEngine();
		engine.addFile('leaf.ts', 'export function leaf(): void {}');
		engine.addFile(
			'inner.ts',
			'export function inner(callback: () => void): void { callback(); }',
		);
		engine.addFile('barrel.ts', "export { inner as renamedInner } from './inner.ts';");
		engine.addFile(
			'outer.ts',
			[
				"import * as steps from './barrel.ts';",
				'const alias = steps.renamedInner;',
				'export function outer(callback: () => void): void {',
				'  const forwarded = callback;',
				'  alias(forwarded);',
				'}',
			].join('\n'),
		);
		engine.addFile(
			'entry.ts',
			[
				"import { leaf } from './leaf.ts';",
				"import { outer } from './outer.ts';",
				'export function entry(): void { outer(leaf); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('entry.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, [
			'inner.ts:symbol:inner',
			'leaf.ts:symbol:leaf',
			'outer.ts:symbol:outer',
		]);
		expect(receipt.results.map((result) => result.witness.length)).toEqual([2, 3, 1]);
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
			'outer.ts:symbol:callback',
		);
	});

	test('binds exact catch patterns and refuses ambiguous throw flow', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'catch-patterns.ts',
			[
				'function getterLeaf(): void {}',
				'function defaultLeaf(): number { return 1; }',
				'class Value { get value(): number { getterLeaf(); return 1; } }',
				'export function exactCatch(): void {',
				'  try { throw [{ nested: new Value() }, undefined]; }',
				'  catch ([{ nested: { value } }, fallback = defaultLeaf()]) { void value; void fallback; }',
				'}',
				'export function restCatch(): void {',
				'  try { throw [undefined, new Value()]; }',
				'  catch ([first = defaultLeaf(), ...[{ value }]]) { void first; void value; }',
				'}',
				'export function ambiguousCatch(flag: boolean): void {',
				'  try { if (flag) throw { value: 1 }; throw { value: 2 }; }',
				'  catch ({ value }) { void value; }',
				'}',
			].join('\n'),
		);
		engine.link();
		for (const name of ['exactCatch', 'restCatch']) {
			const receipt = engine.reaches(engine.anchor('catch-patterns.ts', name)!);
			expect(receipt.state, `${name}: ${JSON.stringify(receipt)}`).toBe('complete');
			expect(
				receipt.results.map((result) => symbolIdentity(result.symbol)),
				name,
			).toEqual(
				expect.arrayContaining([
					'catch-patterns.ts:symbol:Value',
					'catch-patterns.ts:symbol:defaultLeaf',
					'catch-patterns.ts:symbol:getterLeaf',
				]),
			);
			for (const result of receipt.results)
				for (const witness of result.witness)
					expect(engine.resolve(witness)).not.toBeNull();
		}
		const ambiguous = engine.reaches(engine.anchor('catch-patterns.ts', 'ambiguousCatch')!);
		expect(ambiguous.state).toBe('partial');
		if (ambiguous.state !== 'partial') throw new Error('expected catch boundary');
		expect(ambiguous.unresolved.map((gap) => gap.reason)).toEqual(['linked-set-boundary']);
		expect(engine.resolve(ambiguous.unresolved[0]!.site)).not.toBeNull();
	});

	test('binds exact rest pattern arrays for every callable form and implicit constructors', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'rest-patterns.ts',
			[
				'function functionLeaf(): void {}',
				'function arrowLeaf(): void {}',
				'function methodLeaf(): void {}',
				'function constructorLeaf(): void {}',
				'function implicitLeaf(): void {}',
				'class FunctionValue { get value(): number { functionLeaf(); return 1; } }',
				'class ArrowValue { get value(): number { arrowLeaf(); return 1; } }',
				'class MethodValue { get value(): number { methodLeaf(); return 1; } }',
				'class ConstructorValue { get value(): number { constructorLeaf(); return 1; } }',
				'class ImplicitValue { get value(): number { implicitLeaf(); return 1; } }',
				'function functionRest(...[{ value }]: [FunctionValue]): void { void value; }',
				'const arrowRest = (...[{ value }]: [ArrowValue]): void => { void value; };',
				'class MethodHost { method(...[{ value }]: [MethodValue]): void { void value; } }',
				'class ConstructorHost { constructor(...[{ value }]: [ConstructorValue]) { void value; } }',
				'class Base { constructor(...[{ value }]: [ImplicitValue]) { void value; } }',
				'class Derived extends Base {}',
				'function defaultRest(...[{ value } = new FunctionValue()]): void { void value; }',
				'export function restEntry(): void {',
				'  functionRest(new FunctionValue());',
				'  defaultRest();',
				'  arrowRest(new ArrowValue());',
				'  new MethodHost().method(new MethodValue());',
				'  new ConstructorHost(new ConstructorValue());',
				'  new Derived(new ImplicitValue());',
				'}',
				'export function spreadBoundary(values: FunctionValue[]): void { functionRest(...values); }',
				'export function arityBoundary(): void { functionRest(); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('rest-patterns.ts', 'restEntry')!);
		expect(receipt.state, JSON.stringify(receipt)).toBe('complete');
		for (const leaf of [
			'functionLeaf',
			'arrowLeaf',
			'methodLeaf',
			'constructorLeaf',
			'implicitLeaf',
		])
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toContain(
				`rest-patterns.ts:symbol:${leaf}`,
			);
		const boundary = engine.reaches(engine.anchor('rest-patterns.ts', 'spreadBoundary')!);
		expect(boundary.state).toBe('partial');
		if (boundary.state !== 'partial') throw new Error('expected rest boundary');
		expect(boundary.unresolved.map((gap) => gap.reason)).toContain('linked-set-boundary');
		for (const gap of boundary.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		const arity = engine.reaches(engine.anchor('rest-patterns.ts', 'arityBoundary')!);
		expect(arity.state).toBe('partial');
		if (arity.state !== 'partial') throw new Error('expected rest arity boundary');
		expect(arity.unresolved.map((gap) => gap.reason)).toEqual(['linked-set-boundary']);
	});

	test('terminates and stays deterministic across recursive rest-pattern calls', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'rest-cycle.ts',
			[
				'function leaf(): void {}',
				'class Value { get value(): number { leaf(); return 1; } }',
				'function cycle(...[{ value }]: [Value]): void { void value; cycle(new Value()); }',
				'export function entry(): void { cycle(new Value()); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('rest-cycle.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual([
			'rest-cycle.ts:symbol:cycle',
			'rest-cycle.ts:symbol:leaf',
			'rest-cycle.ts:symbol:Value',
		]);
		expect(engine.reaches(engine.anchor('rest-cycle.ts', 'entry')!)).toEqual(receipt);
	});

	test('preserves node ownership through imported rest callees and implicit bases', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'values.ts',
			[
				'export function functionLeaf(): void {}',
				'export function arrowLeaf(): void {}',
				'export function methodLeaf(): void {}',
				'export function constructorLeaf(): void {}',
				'export function implicitLeaf(): void {}',
				'export class FunctionValue { get value(): number { functionLeaf(); return 1; } }',
				'export class ArrowValue { get value(): number { arrowLeaf(); return 1; } }',
				'export class MethodValue { get value(): number { methodLeaf(); return 1; } }',
				'export class ConstructorValue { get value(): number { constructorLeaf(); return 1; } }',
				'export class ImplicitValue { get value(): number { implicitLeaf(); return 1; } }',
			].join('\n'),
		);
		engine.addFile(
			'callees.ts',
			[
				"import { FunctionValue } from './values.ts';",
				'export function functionRest(...[{ value } = new FunctionValue()]): void { void value; }',
				'export const arrowRest = (...[{ value }]: [{ value: number }]): void => { void value; };',
				'export class MethodHost { method(...[{ nested: { value } }]: [{ nested: { value: number } }]): void { void value; } }',
				'export class ConstructorHost { constructor(...[{ value }]: [{ value: number }]) { void value; } }',
				'export class Base { constructor(...[{ value }]: [{ value: number }]) { void value; } }',
			].join('\n'),
		);
		engine.addFile(
			'entry.ts',
			[
				"import { arrowRest, Base, ConstructorHost, functionRest, MethodHost } from './callees.ts';",
				"import { ArrowValue, ConstructorValue, FunctionValue, ImplicitValue, MethodValue } from './values.ts';",
				'class Derived extends Base {}',
				'export function exact(): void {',
				'  const local = new FunctionValue();',
				'  functionRest(local);',
				'  functionRest();',
				'  arrowRest(new ArrowValue());',
				'  new MethodHost().method({ nested: new MethodValue() });',
				'  new ConstructorHost(new ConstructorValue());',
				'  new Derived(new ImplicitValue());',
				'}',
				'export function spread(values: FunctionValue[]): void { functionRest(...values); }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('entry.ts', 'exact')!);
		expect(receipt.state).toBe('complete');
		for (const leaf of [
			'functionLeaf',
			'arrowLeaf',
			'methodLeaf',
			'constructorLeaf',
			'implicitLeaf',
		])
			expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toContain(
				`values.ts:symbol:${leaf}`,
			);
		for (const result of receipt.results) {
			expect(engine.resolve(result.symbol)).not.toBeNull();
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		}
		expect(engine.verify(receipt)).toBe(true);
		expect(engine.reaches(engine.anchor('entry.ts', 'exact')!)).toEqual(receipt);
		const spread = engine.reaches(engine.anchor('entry.ts', 'spread')!);
		expect(spread.state).toBe('partial');
		if (spread.state !== 'partial') throw new Error('expected imported spread boundary');
		expect(spread.unresolved.map((gap) => gap.reason)).toContain('linked-set-boundary');
		for (const gap of spread.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		const anchor = engine.anchor('entry.ts', 'exact')!;
		for (const query of [
			engine.definitionOf(anchor),
			engine.referencesOf(anchor),
			engine.readsOf(anchor),
			engine.writesOf(anchor),
			engine.exportedNames('entry.ts'),
			engine.capturesOf(anchor),
			engine.reachableFrom(anchor),
			engine.reaches(anchor),
			engine.resolveBinding('entry.ts', 'exact'),
		]) {
			expect(['complete', 'partial', 'refused']).toContain(query.state);
			expect(engine.verify(query)).toBe(true);
		}
	});

	test('terminates deterministically across a cross-module rest forwarding cycle', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'cycle-a.ts',
			[
				"import { consume } from './cycle-b.ts';",
				'export function leaf(): void {}',
				'export class Value { get value(): number { leaf(); return 1; } }',
				'export function entry(): void { consume(new Value()); }',
			].join('\n'),
		);
		engine.addFile(
			'cycle-b.ts',
			[
				"import { entry, Value } from './cycle-a.ts';",
				'export function consume(...[{ value }]: [Value]): void {',
				'  void value;',
				'  if (false) entry();',
				'}',
			].join('\n'),
		);
		engine.link();
		const anchor = engine.anchor('cycle-a.ts', 'entry')!;
		const receipt = engine.reaches(anchor);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual([
			'cycle-a.ts:symbol:leaf',
			'cycle-a.ts:symbol:Value',
			'cycle-b.ts:symbol:consume',
		]);
		for (const result of receipt.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		expect(engine.reaches(anchor)).toEqual(receipt);
	});

	test('traverses optional calls, constructors, and tagged templates', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'invocations.ts',
			[
				'function optionalLeaf(): void {}',
				'function constructorLeaf(): void {}',
				'function tagLeaf(): void {}',
				'class LocalConstructor { constructor() { constructorLeaf(); } }',
				'function localTag(_parts: TemplateStringsArray): void { tagLeaf(); }',
				'export function entry(): void {',
				'  optionalLeaf?.();',
				'  new LocalConstructor();',
				'  localTag`value`;',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('invocations.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual(
			expect.arrayContaining([
				'invocations.ts:symbol:LocalConstructor',
				'invocations.ts:symbol:constructorLeaf',
				'invocations.ts:symbol:localTag',
				'invocations.ts:symbol:optionalLeaf',
				'invocations.ts:symbol:tagLeaf',
			]),
		);
		expect(receipt.results).toHaveLength(5);
		for (const result of receipt.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
	});

	test('traverses JSX components and names intrinsic JSX boundaries', () => {
		const engine = new GuesslessEngine();
		engine.addFile('component.tsx', 'export function Component() { return null; }');
		engine.addFile('barrel.ts', "export * as ui from './component.tsx';");
		engine.addFile(
			'entry.tsx',
			[
				"import { ui } from './barrel.ts';",
				'export function entry() { return <><ui.Component /><section /></>; }',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('entry.tsx', 'entry')!);
		expect(receipt.state).toBe('partial');
		assertExactReachability(engine, receipt.results, ['component.tsx:symbol:Component']);
		if (receipt.state !== 'partial') throw new Error('expected intrinsic JSX boundary');
		expect(receipt.unresolved.map((gap) => gap.reason)).toEqual(['unresolved-symbol']);
		expect(engine.resolve(receipt.unresolved[0]!.site)).not.toBeNull();
	});

	test('names unresolved optional-call, constructor, tag, and JSX invocation sites', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'boundaries.tsx',
			[
				'export function entry(): void {',
				'  missingOptional?.();',
				'  new MissingConstructor();',
				'  missingTag`value`;',
				'  void <MissingComponent />;',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('boundaries.tsx', 'entry')!);
		expect(receipt.state).toBe('partial');
		if (receipt.state !== 'partial') throw new Error('expected invocation boundaries');
		expect(receipt.unresolved.map((gap) => gap.reason)).toEqual([
			'unresolved-symbol',
			'unresolved-symbol',
			'unresolved-symbol',
			'unresolved-symbol',
		]);
		expect(new Set(receipt.unresolved.map((gap) => JSON.stringify(gap.site))).size).toBe(4);
		for (const gap of receipt.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
	});

	test('preserves callable identity through a named re-export', () => {
		const engine = new GuesslessEngine();
		engine.addFile('source.ts', 'export function leaf(): void {}');
		engine.addFile('barrel.ts', "export { leaf as renamed } from './source.ts';");
		engine.addFile(
			'consumer.ts',
			"import { renamed } from './barrel.ts'; export function entry(): void { renamed(); }",
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('consumer.ts', 'entry')!);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, ['source.ts:symbol:leaf']);
	});

	test('follows callable aliases and invoked anonymous callbacks without guessing retained callbacks', () => {
		const engine = new GuesslessEngine();
		engine.addFile(
			'focused.ts',
			[
				'export function leaf(): void {}',
				'const alias = leaf;',
				'function invoke(callback: () => void): void { callback(); }',
				'function retain(callback: () => void): () => void { return callback; }',
				'export function entry(): void {',
				'  alias();',
				'  invoke(() => leaf());',
				'  retain(() => leaf());',
				'}',
			].join('\n'),
		);
		engine.link();
		const receipt = engine.reaches(engine.anchor('focused.ts', 'entry')!);
		expect(receipt.state).toBe('partial');
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).toEqual([
			'focused.ts:symbol:invoke',
			'focused.ts:symbol:leaf',
			'focused.ts:symbol:retain',
		]);
		if (receipt.state !== 'partial') throw new Error('expected retained callback boundary');
		expect(receipt.unresolved.map((gap) => gap.reason)).toEqual(['higher-order-call-boundary']);
		for (const result of receipt.results)
			for (const site of result.witness) expect(engine.resolve(site)).not.toBeNull();
		expect(engine.resolve(receipt.unresolved[0]!.site)).not.toBeNull();
	});

	test('traverses modules, wrappers, namespace calls, higher-order invocation, and cycles', () => {
		const engine = fixtureEngine();
		const entry = engine.anchor('reachability-entry.ts', 'completeEntry')!;
		const receipt = engine.reaches(entry);
		expect(receipt.state).toBe('complete');
		expect(engine.verify(receipt)).toBe(true);
		assertExactReachability(engine, receipt.results, [
			'higher-order.ts:symbol:invoke',
			'reachability-cycle.ts:symbol:cycleA',
			'reachability-cycle.ts:symbol:cycleB',
			'reachability-entry.ts:symbol:CrossModuleDerived',
			'reachability-leaf.ts:symbol:arrowRestLeaf',
			'reachability-leaf.ts:symbol:ArrowRestValue',
			'reachability-leaf.ts:symbol:callbackLeaf',
			'reachability-leaf.ts:symbol:catchPatternLeaf',
			'reachability-leaf.ts:symbol:CatchPatternValue',
			'reachability-leaf.ts:symbol:constructorRestLeaf',
			'reachability-leaf.ts:symbol:ConstructorRestValue',
			'reachability-leaf.ts:symbol:functionRestLeaf',
			'reachability-leaf.ts:symbol:FunctionRestValue',
			'reachability-leaf.ts:symbol:implicitRestLeaf',
			'reachability-leaf.ts:symbol:ImplicitRestValue',
			'reachability-leaf.ts:symbol:leaf',
			'reachability-leaf.ts:symbol:methodRestLeaf',
			'reachability-leaf.ts:symbol:MethodRestValue',
			'reachability-middle.ts:symbol:arrowRest',
			'reachability-middle.ts:symbol:catchPattern',
			'reachability-middle.ts:symbol:ConstructorRest',
			'reachability-middle.ts:symbol:functionRest',
			'reachability-middle.ts:symbol:importedRest',
			'reachability-middle.ts:symbol:MethodRest',
			'reachability-middle.ts:symbol:RestBase',
			'reachability-middle.ts:symbol:RestDerived',
			'reachability-middle.ts:symbol:restPatterns',
			'reachability-middle.ts:symbol:wrapper',
		]);
		expect(engine.reaches(entry)).toEqual(receipt);
	});

	test('names every opaque, computed, import, and callback stop with resolvable citations', () => {
		const engine = fixtureEngine();
		const receipt = engine.reaches(engine.anchor('reachability-entry.ts', 'partialEntry')!);
		expect(receipt.state).toBe('partial');
		if (receipt.state !== 'partial') throw new Error('expected reachability boundaries');
		expect(receipt.unresolved.map((gap) => gap.reason)).toEqual(
			expect.arrayContaining([
				'higher-order-call-boundary',
				'dynamic-member-access',
				'builtin-module-boundary',
				'external-module-boundary',
				'unresolved-specifier',
			]),
		);
		expect(new Set(receipt.unresolved.map((gap) => JSON.stringify(gap.site))).size).toBe(
			receipt.unresolved.length,
		);
		for (const gap of receipt.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		expect(receipt.results.map((result) => symbolIdentity(result.symbol))).not.toContain(
			'reachability-leaf.ts:symbol:callbackLeaf:opaque',
		);
	});

	test('terminates recursive cycles without duplicate results', () => {
		const engine = fixtureEngine();
		const entry = engine.anchor('reachability-cycle.ts', 'cycleA')!;
		const receipt = engine.reaches(entry);
		expect(receipt.state).toBe('complete');
		assertExactReachability(engine, receipt.results, ['reachability-cycle.ts:symbol:cycleB']);
		expect(engine.reaches(entry)).toEqual(receipt);
	});

	test('refuses a non-function target', () => {
		const engine = fixtureEngine();
		expect(engine.reaches(engine.anchor('reachability-leaf.ts', 'leafValue')!)).toMatchObject({
			state: 'refused',
			reason: 'unsupported-syntax',
			results: [],
		});
	});

	test('snapshot changes invalidate both reachability receipt kinds', () => {
		const engine = fixtureEngine();
		const reachable = engine.reachableFrom(
			engine.anchor('reachability-entry.ts', 'dependencyEntry')!,
		);
		const reaches = engine.reaches(engine.anchor('reachability-entry.ts', 'completeEntry')!);
		expect(engine.verify(reachable)).toBe(true);
		expect(engine.verify(reaches)).toBe(true);
		engine.addFile('reachability-added.ts', 'export const added = 1;');
		engine.link();
		expect(engine.verify(reachable)).toBe(false);
		expect(engine.verify(reaches)).toBe(false);
		engine.removeFile('reachability-added.ts');
		engine.link();
		expect(
			engine.verify(engine.reaches(engine.anchor('reachability-entry.ts', 'completeEntry')!)),
		).toBe(true);
	});
});
