import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
	anchorSite,
	GuesslessEngine,
	sha256,
	type ReferenceResult,
	type SymbolAnchor,
} from '../src/index.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/adversarial');
type ExpectedQuery = { state: string; request: string; results: string[]; unresolved: string[] };
type Truth = Record<string, ExpectedQuery | string[]>;

function assertUniqueExact(actual: string[], expected: string[], label: string): void {
	expect(new Set(actual).size, `${label} contains duplicate identities`).toBe(actual.length);
	expect(new Set(expected).size, `${label} ground truth contains duplicate identities`).toBe(
		expected.length,
	);
	expect([...actual].sort()).toEqual([...expected].sort());
}

function assertResolvable(
	engine: GuesslessEngine,
	anchors: readonly SymbolAnchor[],
	label: string,
): void {
	for (const anchor of anchors)
		expect(
			engine.resolve(anchor),
			`${label} is unresolvable: ${JSON.stringify(anchor)}`,
		).not.toBeNull();
}

test('every query request, result citation, and unresolved citation matches exact planted identity', () => {
	const engine = new GuesslessEngine();
	for (const name of readdirSync(fixtureDir).filter((file) => /\.(?:js|jsx|ts|tsx)$/.test(file)))
		engine.addFile(name, readFileSync(join(fixtureDir, name), 'utf8'));
	engine.link();
	const truth = JSON.parse(readFileSync(join(fixtureDir, 'ground-truth.json'), 'utf8')) as Truth;
	const target = engine.anchor('definitions.ts', 'target')!;
	const queries = {
		definitionOf: engine.definitionOf(target),
		referencesOf: engine.referencesOf(target),
		readsOf: engine.readsOf(target),
		writesOf: engine.writesOf(target),
		exportedNames: engine.exportedNames('export-star.ts'),
		capturesOf: engine.capturesOf(engine.anchor('definitions.ts', 'makeClosure')!),
		resolveBinding: engine.resolveBinding('definitions.ts', 'target'),
		reachableFrom: engine.reachableFrom(
			engine.anchor('reachability-entry.ts', 'dependencyEntry')!,
		),
		reaches: engine.reaches(engine.anchor('reachability-entry.ts', 'partialEntry')!),
	};

	for (const [name, receipt] of Object.entries(queries)) {
		const expected = truth[name] as ExpectedQuery;
		expect(receipt.state).toBe(expected.state);
		expect(engine.verify(receipt)).toBe(true);
		expect(sha256(receipt.request)).toBe(expected.request);
		const results =
			name === 'referencesOf' || name === 'readsOf' || name === 'writesOf'
				? receipt.results.map(
						(item) =>
							`${sha256((item as { site: SymbolAnchor }).site)}:${(item as { access: string }).access}`,
					)
				: name === 'exportedNames'
					? receipt.results.map(
							(item) =>
								`${sha256((item as { module: SymbolAnchor }).module)}:${(item as { name: string }).name}`,
						)
					: name === 'capturesOf'
						? receipt.results.map((item) => {
								const capture = item as {
									symbol: SymbolAnchor;
									references: SymbolAnchor[];
									isWritten: boolean;
								};
								return `${sha256(capture.symbol)}:${capture.references.map(sha256).join(',')}:${capture.isWritten}`;
							})
						: name === 'reachableFrom' || name === 'reaches'
							? receipt.results.map((item) => {
									const result = item as {
										symbol: SymbolAnchor;
										witness: SymbolAnchor[];
									};
									return `${sha256(result.symbol)}:${result.witness.map(sha256).join(',')}`;
								})
							: receipt.results.map((item) => sha256(item));
		assertUniqueExact(results, expected.results, `${name} results`);
		if (receipt.state === 'partial')
			assertUniqueExact(
				receipt.unresolved.map((item) => `${sha256(item.site)}:${item.reason}`),
				expected.unresolved,
				`${name} unresolved`,
			);
		else expect(expected.unresolved).toEqual([]);
	}

	assertResolvable(engine, queries.definitionOf.results, 'definition result');
	for (const name of ['referencesOf', 'readsOf', 'writesOf'] as const) {
		assertResolvable(
			engine,
			queries[name].results.map((item) => item.site),
			`${name} result`,
		);
		if (queries[name].state === 'partial')
			assertResolvable(
				engine,
				queries[name].unresolved.map((item) => item.site),
				`${name} unresolved`,
			);
	}
	assertResolvable(
		engine,
		queries.exportedNames.results.map((item) => item.module),
		'export module',
	);
	for (const capture of queries.capturesOf.results) {
		assertResolvable(engine, [capture.symbol], 'capture symbol');
		assertResolvable(engine, capture.references, 'capture reference');
	}
	assertResolvable(engine, queries.resolveBinding.results, 'binding result');
	for (const name of ['reachableFrom', 'reaches'] as const)
		for (const result of queries[name].results) {
			assertResolvable(engine, [result.symbol], `${name} symbol`);
			assertResolvable(engine, result.witness, `${name} witness`);
		}
	if (queries.reaches.state === 'partial')
		assertResolvable(
			engine,
			queries.reaches.unresolved.map((item) => item.site),
			'reaches unresolved',
		);

	const capture = engine.capturesOf(engine.anchor('unresolved-capture.ts', 'unresolvedCapture')!);
	const expectedCapture = truth.unresolvedCapture as ExpectedQuery;
	expect(capture.state).toBe(expectedCapture.state);
	expect(sha256(capture.request)).toBe(expectedCapture.request);
	if (capture.state !== 'partial') throw new Error('capture fixture must remain partial');
	assertUniqueExact(
		capture.unresolved.map((item) => `${sha256(item.site)}:${item.reason}`),
		expectedCapture.unresolved,
		'unresolved capture',
	);
	assertResolvable(
		engine,
		capture.unresolved.map((item) => item.site),
		'unresolved capture',
	);

	const scoped = new GuesslessEngine();
	for (const file of ['nested-binding.ts', 'foreign-binding.ts', 'query-identities.ts'])
		scoped.addFile(file, readFileSync(join(fixtureDir, file), 'utf8'));
	scoped.link();
	const nestedModule = scoped.module('nested-binding.ts')!;
	const foreignModule = scoped.module('foreign-binding.ts')!;
	const scopeSite = anchorSite(
		nestedModule,
		nestedModule.findAll('ReturnStatement')[0],
		'binding-scope',
	);
	const foreignScopeSite = anchorSite(
		foreignModule,
		foreignModule.findAll('ReturnStatement')[0],
		'foreign-scope',
	);
	const exactQueries = {
		nestedBinding: scoped.resolveBinding('nested-binding.ts', 'value', 'value', scopeSite),
		foreignBinding: scoped.resolveBinding(
			'nested-binding.ts',
			'value',
			'value',
			foreignScopeSite,
		),
		queryIdentityFirst: scoped.referencesOf(scoped.anchor('query-identities.ts', 'first')!),
		queryIdentitySecond: scoped.referencesOf(scoped.anchor('query-identities.ts', 'second')!),
	};
	for (const [name, receipt] of Object.entries(exactQueries)) {
		const expected = truth[name] as ExpectedQuery;
		expect(receipt.state).toBe(expected.state);
		expect(sha256(receipt.request)).toBe(expected.request);
		const results =
			name === 'nestedBinding' || name === 'foreignBinding'
				? receipt.results.map(sha256)
				: receipt.results.map(
						(item) =>
							`${sha256((item as { site: SymbolAnchor }).site)}:${(item as { access: string }).access}`,
					);
		assertUniqueExact(results, expected.results, name);
		if (name === 'nestedBinding' || name === 'foreignBinding')
			assertResolvable(scoped, receipt.results as SymbolAnchor[], name);
		else
			assertResolvable(
				scoped,
				receipt.results.map((item) => (item as ReferenceResult).site),
				name,
			);
	}
	expect(exactQueries.foreignBinding).toMatchObject({
		state: 'refused',
		reason: 'unresolved-symbol',
		results: [],
	});
	expect(exactQueries.queryIdentityFirst.request).not.toEqual(
		exactQueries.queryIdentitySecond.request,
	);

	const invocationEngine = new GuesslessEngine();
	invocationEngine.addFile(
		'invocation-complete.tsx',
		[
			'function optionalLeaf(): void {}',
			'function constructorLeaf(): void {}',
			'function tagLeaf(): void {}',
			'function callbackLeaf(): void {}',
			'function inner(callback: () => void): void { callback(); }',
			'function outer(callback: () => void): void { inner(callback); }',
			'class LocalConstructor { constructor() { constructorLeaf(); } }',
			'function localTag(_parts: TemplateStringsArray): void { tagLeaf(); }',
			'function Component() { return null; }',
			'export function entry(): void {',
			'  optionalLeaf?.();',
			'  new LocalConstructor();',
			'  localTag`value`;',
			'  outer(callbackLeaf);',
			'  void <Component />;',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'invocation-boundaries.tsx',
		[
			'export function entry(): void {',
			'  missingOptional?.();',
			'  new MissingConstructor();',
			'  missingTag`value`;',
			'  void <MissingComponent />;',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'binding-default.ts',
		[
			'function leaf(): void {}',
			'function invoke(callback: () => void = leaf): void { callback(); }',
			'export function complete(): void { invoke(); }',
			'export function omitted(): void {',
			'const required = (callback: () => void): void => callback();',
			'required();',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'class-base.ts',
		[
			'export function fieldLeaf(): number { return 1; }',
			'export function constructorLeaf(): void {}',
			'export class Base {',
			'  value = fieldLeaf();',
			'  constructor() { constructorLeaf(); }',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'class-barrel.ts',
		"export { Base as RenamedBase } from './class-base.ts';",
	);
	invocationEngine.addFile(
		'class-derived.ts',
		[
			"import * as models from './class-barrel.ts';",
			'const BaseAlias = models.RenamedBase;',
			'export function derivedLeaf(): number { return 1; }',
			'export class Derived extends BaseAlias { value = derivedLeaf(); }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'class-entry.ts',
		[
			"import { Derived } from './class-derived.ts';",
			'export function entry(): void { new Derived(); }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'jsx-class.tsx',
		[
			'function hidden(): number { return 1; }',
			'class Component { value = hidden(); }',
			'export function entry() { return <Component />; }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'default-undefined.ts',
		[
			'function defaultLeaf(): void {}',
			'function shadowLeaf(): void {}',
			'function invoke(callback: () => void = defaultLeaf): void { callback(); }',
			'function shadowed(undefined: () => void = shadowLeaf): void { invoke(undefined); }',
			'export function unshadowed(): void { invoke(undefined); }',
			'export function shadowedEntry(): void { shadowed(); }',
			'export function uncertain(value: unknown): void { invoke(value); }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'class-call-mode.ts',
		[
			'function hidden(): number { return 1; }',
			'class Example { value = hidden(); }',
			'export function invalid(): void { Example(); }',
		].join('\n'),
	);
	invocationEngine.addFile(
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
	invocationEngine.addFile(
		'accessor-derived.ts',
		[
			"import { Base } from './accessor-base.ts';",
			'export class Derived extends Base {',
			'  copied = this.value;',
			'  constructor() { super(); this.value = 2; }',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'accessor-entry.ts',
		[
			"import { Derived } from './accessor-derived.ts';",
			'export function complete(): void {',
			'  const instance = new Derived();',
			'  instance.value;',
			'  instance.value = 2;',
			'}',
			'export function boundary(receiver: unknown): void {',
			'  receiver.value;',
			'  receiver["value"];',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'equivalent-default.ts',
		[
			'function leaf(): void {}',
			'function invoke(callback: () => void = leaf): void { callback(); }',
			'const direct = undefined;',
			'const wrapped = (direct as undefined)!;',
			'const chained = wrapped;',
			'let mutable = undefined;',
			'export function immutable(): void { invoke(chained); }',
			'export function uncertain(): void { invoke(mutable); }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'canonical-accessor-base.ts',
		[
			"const COMPUTED = 'computed' as const;",
			'export function plainLeaf(): number { return 1; }',
			'export function literalLeaf(): number { return 1; }',
			'export function numericLeaf(): number { return 1; }',
			'export function computedLeaf(): number { return 1; }',
			'export function privateLeaf(): number { return 1; }',
			'export class Base {',
			'  get plain(): number { return plainLeaf(); }',
			'  get "literal"(): number { return literalLeaf(); }',
			'  get 1(): number { return numericLeaf(); }',
			'  get [COMPUTED](): number { return computedLeaf(); }',
			'  get #secret(): number { return privateLeaf(); }',
			'  privateCopy = this.#secret;',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'canonical-accessor-derived.ts',
		[
			"import { Base } from './canonical-accessor-base.ts';",
			'export class Derived extends Base { superCopy = super.plain; }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'canonical-accessor-entry.ts',
		[
			"import { Derived } from './canonical-accessor-derived.ts';",
			"const key = 'computed' as const;",
			'export function entry(): void {',
			'  const item = new Derived();',
			'  item.plain;',
			'  item["literal"];',
			'  item[1];',
			'  item[key];',
			'}',
		].join('\n'),
	);
	invocationEngine.addFile(
		'pattern-accessor.ts',
		[
			'function alphaLeaf(): number { return 1; }',
			'function betaLeaf(): number { return 1; }',
			'class Known {',
			'  get alpha(): number { return alphaLeaf(); }',
			'  get "beta"(): number { return betaLeaf(); }',
			'}',
			'export function complete(): void {',
			'  const item = new Known();',
			'  const { alpha } = item;',
			'  let beta = 0;',
			'  ({ ["beta"]: beta } = item);',
			'}',
			'export function boundary(receiver: unknown, key: string): void {',
			'  const item = new Known();',
			'  const { [key]: dynamic, ...rest } = item;',
			'  const copied = { ...item };',
			'  const { alpha } = receiver;',
			'}',
			'class Cycle {',
			'  get first(): number { return this.second; }',
			'  get second(): number { return this.first; }',
			'}',
			'export function cycle(): void { new Cycle().first; }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'pattern-undefined-exact.ts',
		[
			'function leaf(): void {}',
			'function invoke(callback: () => void = leaf): void { callback(); }',
			'const [{ value }] = [{ value: undefined }];',
			'let [mutable] = [undefined];',
			'export function exact(): void { invoke(value); }',
			'export function uncertain(): void { invoke(mutable); }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'static-key-exact.ts',
		[
			'function templateLeaf(): number { return 1; }',
			'function signedLeaf(): number { return 1; }',
			'let unknownKey = "unknown";',
			'class Known {',
			'  get [`template`](): number { return templateLeaf(); }',
			'  get [-1](): number { return signedLeaf(); }',
			'  get [unknownKey](): number { return 1; }',
			'}',
			'export function complete(): void {',
			'  const item = new Known();',
			'  item[`template`];',
			'  item[-1];',
			'}',
			'export function boundary(): void { const item = new Known(); item.missing; }',
		].join('\n'),
	);
	invocationEngine.addFile(
		'executable-pattern-exact.ts',
		[
			'function leaf(): number { return 1; }',
			'class Source { get value(): number { return leaf(); } }',
			'function nested({ holder }: { holder: Source }): void { holder.value; }',
			'class Consumer { consume({ value }: Source): void {} }',
			'export function complete(): void {',
			'  const item = new Source();',
			'  nested({ holder: item });',
			'  const consumer = new Consumer();',
			'  consumer.consume(item);',
			'  for (const { value } of [item]) void value;',
			'}',
			'export function boundary(iterable: unknown, receiver: unknown): void {',
			'  for (const { value } of iterable) void value;',
			'  for (const key in receiver) void key;',
			'  const { child: { value } } = receiver;',
			'}',
		].join('\n'),
	);
	invocationEngine.link();
	const invocationQueries = {
		invocationComplete: invocationEngine.reaches(
			invocationEngine.anchor('invocation-complete.tsx', 'entry')!,
		),
		invocationBoundaries: invocationEngine.reaches(
			invocationEngine.anchor('invocation-boundaries.tsx', 'entry')!,
		),
		callableDefault: invocationEngine.reaches(
			invocationEngine.anchor('binding-default.ts', 'complete')!,
		),
		omittedCallable: invocationEngine.reaches(
			invocationEngine.anchor('binding-default.ts', 'omitted')!,
		),
		classConstruction: invocationEngine.reaches(
			invocationEngine.anchor('class-entry.ts', 'entry')!,
		),
		jsxClass: invocationEngine.reaches(invocationEngine.anchor('jsx-class.tsx', 'entry')!),
		defaultUndefined: invocationEngine.reaches(
			invocationEngine.anchor('default-undefined.ts', 'unshadowed')!,
		),
		shadowedUndefined: invocationEngine.reaches(
			invocationEngine.anchor('default-undefined.ts', 'shadowedEntry')!,
		),
		uncertainUndefined: invocationEngine.reaches(
			invocationEngine.anchor('default-undefined.ts', 'uncertain')!,
		),
		invalidClassCall: invocationEngine.reaches(
			invocationEngine.anchor('class-call-mode.ts', 'invalid')!,
		),
		accessorComplete: invocationEngine.reaches(
			invocationEngine.anchor('accessor-entry.ts', 'complete')!,
		),
		accessorBoundary: invocationEngine.reaches(
			invocationEngine.anchor('accessor-entry.ts', 'boundary')!,
		),
		immutableAlias: invocationEngine.reaches(
			invocationEngine.anchor('equivalent-default.ts', 'immutable')!,
		),
		uncertainAlias: invocationEngine.reaches(
			invocationEngine.anchor('equivalent-default.ts', 'uncertain')!,
		),
		canonicalAccessor: invocationEngine.reaches(
			invocationEngine.anchor('canonical-accessor-entry.ts', 'entry')!,
		),
		destructuringAccessor: invocationEngine.reaches(
			invocationEngine.anchor('pattern-accessor.ts', 'complete')!,
		),
		patternBoundary: invocationEngine.reaches(
			invocationEngine.anchor('pattern-accessor.ts', 'boundary')!,
		),
		accessorCycle: invocationEngine.reaches(
			invocationEngine.anchor('pattern-accessor.ts', 'cycle')!,
		),
		patternUndefinedExact: invocationEngine.reaches(
			invocationEngine.anchor('pattern-undefined-exact.ts', 'exact')!,
		),
		patternUndefinedUncertain: invocationEngine.reaches(
			invocationEngine.anchor('pattern-undefined-exact.ts', 'uncertain')!,
		),
		staticKeyExact: invocationEngine.reaches(
			invocationEngine.anchor('static-key-exact.ts', 'complete')!,
		),
		staticKeyBoundary: invocationEngine.reaches(
			invocationEngine.anchor('static-key-exact.ts', 'boundary')!,
		),
		executablePatternExact: invocationEngine.reaches(
			invocationEngine.anchor('executable-pattern-exact.ts', 'complete')!,
		),
		executablePatternBoundary: invocationEngine.reaches(
			invocationEngine.anchor('executable-pattern-exact.ts', 'boundary')!,
		),
	};
	for (const [name, receipt] of Object.entries(invocationQueries)) {
		const expected = truth[name] as ExpectedQuery;
		const results = receipt.results.map(
			(result) => `${sha256(result.symbol)}:${result.witness.map(sha256).join(',')}`,
		);
		const unresolved =
			receipt.state === 'partial'
				? receipt.unresolved.map((item) => `${sha256(item.site)}:${item.reason}`)
				: [];
		expect(receipt.state).toBe(expected.state);
		expect(invocationEngine.verify(receipt)).toBe(true);
		expect(sha256(receipt.request)).toBe(expected.request);
		assertUniqueExact(results, expected.results, `${name} results`);
		assertUniqueExact(unresolved, expected.unresolved, `${name} unresolved`);
		for (const result of receipt.results) {
			assertResolvable(invocationEngine, [result.symbol], `${name} symbol`);
			assertResolvable(invocationEngine, result.witness, `${name} witness`);
		}
		if (receipt.state === 'partial')
			assertResolvable(
				invocationEngine,
				receipt.unresolved.map((item) => item.site),
				`${name} unresolved`,
			);
	}

	for (const language of truth.languages as string[])
		expect(engine.module(language)?.diagnostics).toEqual([]);
}, 20_000);

test('safe-change receipts preserve exact unique resolvable identities and uncertainty', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const target = 1;');
	engine.addFile(
		'consumer.ts',
		"import * as source from './source'; declare const key: string; source.target; source[key];",
	);
	engine.link();
	const target = engine.anchor('source.ts', 'target')!;
	const receipt = engine.safeChangeImpact(engine.snapshot(), 'rename', target);
	expect(receipt.state).toBe('partial');
	expect(engine.verify(receipt)).toBe(true);
	expect(new Set(receipt.results.map((result) => sha256(result.site))).size).toBe(
		receipt.results.length,
	);
	assertResolvable(
		engine,
		receipt.results.map((result) => result.site),
		'safe-change result',
	);
	for (const result of receipt.results)
		assertResolvable(engine, result.witness, 'safe-change witness');
	if (receipt.state !== 'partial') return;
	expect(
		new Set(receipt.unresolved.map((item) => `${sha256(item.site)}:${item.reason}`)).size,
	).toBe(receipt.unresolved.length);
	assertResolvable(
		engine,
		receipt.unresolved.map((item) => item.site),
		'safe-change unresolved',
	);
});
