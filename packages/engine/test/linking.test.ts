import { describe, expect, test } from 'vitest';
import { GuesslessEngine, type Receipt, type UnresolvedSite } from '../src/index.ts';

/**
 * D1: a supplied input that imports project files through a specifier the
 * engine cannot resolve (webpack-style `resolve.modules` aliases) never joins
 * the module graph. Before this suite the file was absent from a traversal's
 * `results` *and* from its `unresolved` list, so a receipt could read
 * honestly-partial while whole files were invisible. Evidence:
 * docs/evidence/adoption-eval-fable-v1/raw-versionless/q23 (alias imports,
 * saga.js missing everywhere) vs q25 (same repo, two import strings
 * relativised, saga.js sites returned).
 */

function engineWith(files: Record<string, string>): GuesslessEngine {
	const engine = new GuesslessEngine();
	for (const [path, source] of Object.entries(files)) engine.addFile(path, source);
	engine.link();
	return engine;
}

function gaps(receipt: Receipt<unknown>): readonly UnresolvedSite[] {
	return receipt.state === 'partial' ? receipt.unresolved : [];
}

function unlinked(receipt: Receipt<unknown>): readonly UnresolvedSite[] {
	return gaps(receipt).filter((gap) => gap.reason === 'unlinked-input');
}

function siteFiles(receipt: Receipt<{ site: { file: string } }>): string[] {
	return receipt.state === 'refused' ? [] : receipt.results.map((result) => result.site.file);
}

function assertCitable(engine: GuesslessEngine, receipt: Receipt<unknown>): void {
	for (const gap of gaps(receipt)) expect(engine.resolve(gap.site)).not.toBeNull();
}

describe('unlinked supplied inputs are named, never silently dropped', () => {
	const aliasSaga = [
		"import { loadRepos } from 'containers/App/actions';",
		'export function getRepos() { return loadRepos(); }',
	].join(' ');
	const relativeSaga = [
		"import { loadRepos } from '../App/actions';",
		'export function getRepos() { return loadRepos(); }',
	].join(' ');
	const boilerplate = (saga: string) => ({
		'app/containers/App/actions.js': 'export function loadRepos() { return 1; }',
		'app/containers/HomePage/saga.js': saga,
		'app/containers/HomePage/index.js':
			"import { getRepos } from './saga'; export function HomePage() { return getRepos(); }",
	});

	test('q23 reproduction: alias-imported file absent from results is named unresolved', () => {
		const engine = engineWith(boilerplate(aliasSaga));
		const receipt = engine.referencesOf(
			engine.anchor('app/containers/App/actions.js', 'loadRepos')!,
		);
		expect(receipt.state).toBe('partial');
		expect(siteFiles(receipt)).not.toContain('app/containers/HomePage/saga.js');
		const named = unlinked(receipt);
		expect(named.map((gap) => gap.site.file)).toEqual(['app/containers/HomePage/saga.js']);
		expect(named[0].detail).toContain("'containers/App/actions'");
		expect(named[0].detail).toContain('names a supplied input');
		assertCitable(engine, receipt);
	});

	test('q25 twin: relativising the specifier returns the sites and drops the entry', () => {
		const engine = engineWith(boilerplate(relativeSaga));
		const receipt = engine.referencesOf(
			engine.anchor('app/containers/App/actions.js', 'loadRepos')!,
		);
		expect(siteFiles(receipt)).toContain('app/containers/HomePage/saga.js');
		expect(unlinked(receipt)).toEqual([]);
		expect(receipt.state).toBe('complete');
	});

	test('a receipt that would read complete over an unlinked input reads partial', () => {
		const linked = engineWith(boilerplate(relativeSaga));
		const aliased = engineWith(boilerplate(aliasSaga));
		expect(
			linked.referencesOf(linked.anchor('app/containers/App/actions.js', 'loadRepos')!).state,
		).toBe('complete');
		expect(
			aliased.referencesOf(aliased.anchor('app/containers/App/actions.js', 'loadRepos')!)
				.state,
		).toBe('partial');
	});

	test('chained alias: a file reachable only through another alias is named too', () => {
		const engine = engineWith({
			'app/store/actions.js': 'export function act() { return 1; }',
			'app/features/mid.js':
				"import { act } from 'store/actions'; export function mid() { return act(); }",
			'app/features/top.js':
				"import { mid } from 'features/mid'; export function top() { return mid(); }",
		});
		const receipt = engine.referencesOf(engine.anchor('app/store/actions.js', 'act')!);
		expect(receipt.state).toBe('partial');
		expect(unlinked(receipt).map((gap) => gap.site.file).sort()).toEqual([
			'app/features/mid.js',
			'app/features/top.js',
		]);
		assertCitable(engine, receipt);
	});

	test('alias re-export: an unresolved `export ... from` specifier is named', () => {
		const engine = engineWith({
			'app/thing.js': 'export const thing = 1;',
			'app/barrel.js': "export { thing } from 'app/thing';",
			'app/consumer.js': "import { thing } from './barrel'; export const used = thing;",
		});
		const receipt = engine.referencesOf(engine.anchor('app/thing.js', 'thing')!);
		expect(receipt.state).toBe('partial');
		const named = unlinked(receipt);
		expect(named.map((gap) => gap.site.file)).toEqual(['app/barrel.js']);
		expect(named[0].detail).toContain("Export from 'app/thing'");
		assertCitable(engine, receipt);
	});

	test('reachability queries name unlinked inputs the walk never visited', () => {
		const engine = engineWith({
			'app/entry.js': "import { leaf } from './leaf'; export function entry() { return leaf(); }",
			'app/leaf.js': 'export function leaf() { return 1; }',
			'app/detached.js': "import { leaf } from 'app/leaf'; export function detached() { return leaf(); }",
		});
		const forward = engine.reachableFrom(engine.anchor('app/entry.js', 'entry')!);
		const backward = engine.reaches(engine.anchor('app/leaf.js', 'leaf')!);
		for (const receipt of [forward, backward]) {
			expect(receipt.state).toBe('partial');
			expect(unlinked(receipt).map((gap) => gap.site.file)).toEqual(['app/detached.js']);
			assertCitable(engine, receipt);
		}
	});

	test('definitionOf over an alias-imported binding names the failed link', () => {
		const engine = engineWith({
			'app/thing.js': 'export const thing = 1;',
			'app/user.js': "import { thing } from 'app/thing'; export const used = thing;",
		});
		const receipt = engine.definitionOf(engine.anchor('app/user.js', 'thing')!);
		expect(receipt.state).toBe('partial');
		expect(unlinked(receipt).map((gap) => gap.site.file)).toEqual(['app/user.js']);
		assertCitable(engine, receipt);
	});

	test('an unlinked input inside the traversed graph is named, not called external', () => {
		// The importer is itself a dependent of the target, so it *is* traversed;
		// calling its alias specifier an external package would be a lie, since
		// the specifier names a supplied file.
		const engine = engineWith({
			'app/core.js': 'export const core = 1;',
			'app/consumer.js':
				"import { core } from './core'; import { extra } from 'app/extra'; export const used = core + extra;",
			'app/extra.js': 'export const extra = 2;',
		});
		const receipt = engine.referencesOf(engine.anchor('app/core.js', 'core')!);
		expect(receipt.state).toBe('partial');
		const named = unlinked(receipt);
		expect(named.map((gap) => gap.site.file)).toEqual(['app/consumer.js']);
		expect(gaps(receipt).some((gap) => gap.reason === 'external-module-boundary')).toBe(false);
		assertCitable(engine, receipt);
	});
});

describe('negative control: linked inputs gain no noise', () => {
	const files = {
		'app/core.js': 'export const core = 1;',
		'app/mid.js': "import { core } from './core'; export const mid = core + 1;",
		'app/leaf.js': "import { mid } from './mid'; export const leaf = mid + 1;",
		'app/unrelated.js': "import { helper } from './helper'; export const spare = helper;",
		'app/helper.js': 'export const helper = 0;',
	};

	test('a fully linked set answers complete with unchanged results', () => {
		const engine = engineWith(files);
		const receipt = engine.referencesOf(engine.anchor('app/core.js', 'core')!);
		expect(receipt.state).toBe('complete');
		// Both sites live in the one importing file: its import specifier (D2)
		// and the use of the imported binding. No other file gains noise.
		expect(siteFiles(receipt)).toEqual(['app/mid.js', 'app/mid.js']);
		expect(engine.reachableFrom(engine.anchor('app/leaf.js', 'leaf')!).state).toBe('complete');
	});

	test('recognised external and builtin specifiers raise nothing new', () => {
		// A package specifier that names no supplied path cannot hide a supplied
		// file, so an unrelated file importing one stays silent — the receipt is
		// identical to the one over the set without it.
		const plain = engineWith(files);
		const withExternals = engineWith({
			...files,
			'app/external.js':
				"import react from 'react'; import { readFileSync } from 'node:fs'; export const shell = [react, readFileSync];",
		});
		const receipt = withExternals.referencesOf(withExternals.anchor('app/core.js', 'core')!);
		expect(receipt.state).toBe('complete');
		expect(unlinked(receipt)).toEqual([]);
		expect(siteFiles(receipt)).toEqual(
			siteFiles(plain.referencesOf(plain.anchor('app/core.js', 'core')!)),
		);
	});

	test('an in-graph external or builtin boundary keeps its existing reason', () => {
		const engine = engineWith({
			...files,
			'app/mid.js':
				"import { core } from './core'; import react from 'react'; import { readFileSync } from 'node:fs'; export const mid = [core, react, readFileSync];",
		});
		const receipt = engine.referencesOf(engine.anchor('app/core.js', 'core')!);
		expect(receipt.state).toBe('partial');
		expect(gaps(receipt).map((gap) => gap.reason).sort()).toEqual([
			'builtin-module-boundary',
			'external-module-boundary',
		]);
	});

	test('an unresolved relative specifier stays an unresolved-specifier boundary', () => {
		// A relative miss proves the target was never supplied: yuku resolves
		// relative specifiers against the supplied set directly, so no supplied
		// input is hidden behind it and the reason must not change.
		const engine = engineWith({
			...files,
			'app/mid.js':
				"import { core } from './core'; import './styles.css'; export const mid = core + 1;",
		});
		const receipt = engine.referencesOf(engine.anchor('app/core.js', 'core')!);
		expect(unlinked(receipt)).toEqual([]);
		expect(gaps(receipt).map((gap) => gap.reason)).toEqual(['unresolved-specifier']);
	});
});
