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

function workspaceStranded(receipt: Receipt<unknown>): readonly UnresolvedSite[] {
	return gaps(receipt).filter((gap) => gap.reason === 'unlinked-workspace-package');
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

/**
 * D6: a supplied input whose only route to the corpus is a workspace package
 * specifier ('@markless/serializer') was invisible in traversal receipts. The
 * specifier is not a path suffix of 'packages/serializer/src/index.ts', so
 * `boundaryReason` called it 'external-module-boundary' and `unlinkedInputSites`
 * skipped it: the file sat outside the dependents closure *and* outside the
 * naming pass. Evidence:
 * docs/evidence/adoption-eval-fable-v2/demonstration/report.md (falsifier F2 —
 * 19 real reference sites in 6 files absent from a 635-file receipt entirely).
 *
 * The repair names, and deliberately does not link: the supplied set carries no
 * manifest, no 'exports' map and no workspace globs, so which supplied file is a
 * package's entry point is not knowable. A guessed edge would manufacture
 * results, which is worse than the silence it replaced.
 */
describe('workspace package specifiers strand supplied inputs visibly', () => {
	const monorepo = {
		'packages/serializer/src/value-decode.ts':
			'export function deserializeGraphValue(value) { return value; }',
		'packages/serializer/src/index.ts':
			"export { deserializeGraphValue } from './value-decode.ts';",
		'packages/serializer/src/protocol.ts':
			"import { deserializeGraphValue } from './value-decode.ts'; export const decode = deserializeGraphValue;",
		'packages/web/src/ssr.ts':
			"import { deserializeGraphValue } from '@markless/serializer'; export const ssr = deserializeGraphValue(1);",
		'packages/compiler/src/render.ts':
			"import { deserializeGraphValue } from '@markless/serializer/protocol'; export const render = deserializeGraphValue(2);",
	};

	test('F2 reproduction: a file reaching the target only through @scope/pkg is named', () => {
		const engine = engineWith(monorepo);
		const receipt = engine.referencesOf(
			engine.anchor('packages/serializer/src/value-decode.ts', 'deserializeGraphValue')!,
		);
		expect(receipt.state).toBe('partial');
		// Not linked: no result may be claimed for a file the engine never joined.
		expect(siteFiles(receipt)).not.toContain('packages/web/src/ssr.ts');
		// Not silent either: the file is named, with the specifier that stranded it.
		const named = workspaceStranded(receipt);
		expect(named.map((gap) => gap.site.file).sort()).toEqual([
			'packages/compiler/src/render.ts',
			'packages/web/src/ssr.ts',
		]);
		const web = named.find((gap) => gap.site.file === 'packages/web/src/ssr.ts')!;
		expect(web.detail).toContain("'@markless/serializer'");
		expect(web.detail).toContain("'packages/serializer'");
		expect(web.detail).toContain("entry point");
		assertCitable(engine, receipt);
	});

	test('a subpath specifier is named through its package name, not guessed onto a file', () => {
		// '@markless/serializer/protocol' could mean 'packages/serializer/protocol.ts',
		// 'packages/serializer/src/protocol.ts', or nothing at all: the 'exports'
		// map that decides is not a supplied input. The package name is the only
		// part with evidence behind it, so it is the only part used.
		const engine = engineWith(monorepo);
		const receipt = engine.referencesOf(
			engine.anchor('packages/serializer/src/value-decode.ts', 'deserializeGraphValue')!,
		);
		expect(siteFiles(receipt)).not.toContain('packages/compiler/src/render.ts');
		const compiler = workspaceStranded(receipt).find(
			(gap) => gap.site.file === 'packages/compiler/src/render.ts',
		)!;
		expect(compiler.detail).toContain("'@markless/serializer/protocol'");
		expect(compiler.detail).toContain("'packages/serializer'");
	});

	test('an unscoped workspace name is named on the same evidence', () => {
		const engine = engineWith({
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/core/src/index.ts': "export { thing } from './thing.ts';",
			'packages/app/src/use.ts': "import { thing } from 'core'; export const used = thing;",
		});
		const receipt = engine.referencesOf(engine.anchor('packages/core/src/thing.ts', 'thing')!);
		expect(receipt.state).toBe('partial');
		expect(workspaceStranded(receipt).map((gap) => gap.site.file)).toEqual([
			'packages/app/src/use.ts',
		]);
	});

	test('an ambiguous tail is named with every candidate root, never guess-linked', () => {
		// Two supplied directories are called 'core'. Nothing in the supplied set
		// says which one '@acme/core' means, so the engine draws no edge and says
		// so, listing both candidates rather than picking one.
		const engine = engineWith({
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/core/src/index.ts': "export { thing } from './thing.ts';",
			'apps/core/src/index.ts': 'export const thing = 2;',
			'packages/app/src/use.ts': "import { thing } from '@acme/core'; export const used = thing;",
		});
		const receipt = engine.referencesOf(engine.anchor('packages/core/src/thing.ts', 'thing')!);
		expect(receipt.state).toBe('partial');
		expect(siteFiles(receipt)).not.toContain('packages/app/src/use.ts');
		const named = workspaceStranded(receipt);
		expect(named.map((gap) => gap.site.file)).toEqual(['packages/app/src/use.ts']);
		expect(named[0].detail).toContain('ambiguous');
		expect(named[0].detail).toContain("'apps/core'");
		expect(named[0].detail).toContain("'packages/core'");
		assertCitable(engine, receipt);
	});

	test('a workspace re-export specifier is named like an import', () => {
		const engine = engineWith({
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/app/src/barrel.ts': "export { thing } from '@acme/core';",
			'packages/app/src/use.ts': "import { thing } from './barrel.ts'; export const used = thing;",
		});
		const receipt = engine.referencesOf(engine.anchor('packages/core/src/thing.ts', 'thing')!);
		const named = workspaceStranded(receipt);
		expect(named.map((gap) => gap.site.file)).toEqual(['packages/app/src/barrel.ts']);
		expect(named[0].detail).toContain("Export from '@acme/core'");
		assertCitable(engine, receipt);
	});

	test('a genuinely external package the corpus never contains stays external and silent', () => {
		// 'react' matches no supplied directory, so it cannot hide a supplied file:
		// the reason is unchanged and the receipt is identical to the one over the
		// set without the importing file. Over-naming is bounded by evidence.
		const base = {
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/core/src/index.ts': "export { thing } from './thing.ts';",
			'packages/app/src/use.ts': "import { thing } from '../../core/src/thing.ts'; export const used = thing;",
		};
		const plain = engineWith(base);
		const withExternal = engineWith({
			...base,
			'packages/app/src/shell.ts':
				"import react from 'react'; import { readFileSync } from 'node:fs'; export const shell = [react, readFileSync];",
		});
		const receipt = withExternal.referencesOf(
			withExternal.anchor('packages/core/src/thing.ts', 'thing')!,
		);
		expect(receipt.state).toBe('complete');
		expect(workspaceStranded(receipt)).toEqual([]);
		expect(siteFiles(receipt)).toEqual(
			siteFiles(plain.referencesOf(plain.anchor('packages/core/src/thing.ts', 'thing')!)),
		);
	});

	test('an in-graph workspace specifier is named, not called external', () => {
		// The importer is a dependent of the target through a relative import, so
		// it is traversed; its second, workspace-shaped specifier must still not be
		// dismissed as an external package.
		const engine = engineWith({
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/other/src/index.ts': 'export const extra = 2;',
			'packages/app/src/use.ts':
				"import { thing } from '../../core/src/thing.ts'; import { extra } from '@acme/other'; export const used = thing + extra;",
		});
		const receipt = engine.referencesOf(engine.anchor('packages/core/src/thing.ts', 'thing')!);
		expect(receipt.state).toBe('partial');
		expect(gaps(receipt).map((gap) => gap.reason)).toEqual(['unlinked-workspace-package']);
		expect(gaps(receipt)[0].site.file).toBe('packages/app/src/use.ts');
	});

	test('reachability queries name workspace-stranded inputs the walk never visited', () => {
		const engine = engineWith(monorepo);
		const forward = engine.reachableFrom(
			engine.anchor('packages/serializer/src/protocol.ts', 'decode')!,
		);
		const backward = engine.reaches(
			engine.anchor('packages/serializer/src/value-decode.ts', 'deserializeGraphValue')!,
		);
		for (const receipt of [forward, backward]) {
			expect(receipt.state).toBe('partial');
			expect(workspaceStranded(receipt).map((gap) => gap.site.file).sort()).toEqual([
				'packages/compiler/src/render.ts',
				'packages/web/src/ssr.ts',
			]);
			assertCitable(engine, receipt);
		}
	});

	test('a file-path match keeps the stronger reason; only root matches get the weaker one', () => {
		// 'core/src/thing.ts' is a path suffix of a supplied file, so it stays
		// 'unlinked-input'. The two evidence strengths are never merged.
		const engine = engineWith({
			'packages/core/src/thing.ts': 'export const thing = 1;',
			'packages/app/src/byPath.ts':
				"import { thing } from 'core/src/thing.ts'; export const a = thing;",
			'packages/app/src/byName.ts': "import { thing } from '@acme/core'; export const b = thing;",
		});
		const receipt = engine.referencesOf(engine.anchor('packages/core/src/thing.ts', 'thing')!);
		expect(unlinked(receipt).map((gap) => gap.site.file)).toEqual([
			'packages/app/src/byPath.ts',
		]);
		expect(workspaceStranded(receipt).map((gap) => gap.site.file)).toEqual([
			'packages/app/src/byName.ts',
		]);
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
