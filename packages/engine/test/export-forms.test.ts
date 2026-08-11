import { describe, expect, test } from 'vitest';
import { GuesslessEngine, type Receipt, type UnresolvedSite } from '../src/index.ts';

/**
 * D4: export forms outside the ES module system. `exportedNames` answers from
 * the ES export records only, so a CommonJS module returned `partial` with zero
 * results whose `unresolved` list named nothing but its require boundaries — a
 * consumer could not tell "this module exports nothing" from "this module's
 * exports are invisible to me". Evidence:
 * docs/evidence/adoption-eval-fable-v1/raw-versionless/q11-exportednames-i18n-cjs.receipt.json
 * (four real CommonJS exports, five unresolved sites, none of them an export).
 *
 * The fix names the constructs; it does not analyze them. No CommonJS name is
 * ever claimed as a result: guessless stays an ES-analysis engine, and the
 * boundary is the product.
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

function exportForms(receipt: Receipt<unknown>): readonly UnresolvedSite[] {
	return gaps(receipt).filter((gap) => gap.reason === 'unrecognized-export-form');
}

function assertCitable(engine: GuesslessEngine, receipt: Receipt<unknown>): void {
	for (const gap of gaps(receipt)) expect(engine.resolve(gap.site)).not.toBeNull();
}

describe('unclassifiable export forms are named, never silently absent', () => {
	test('q11 reproduction: a CommonJS module names every export construct', () => {
		const engine = engineWith({
			'i18n.js': [
				"const addLocaleData = require('react-intl');",
				'function translationMessages() {}',
				'const formatTranslationMessages = () => {};',
				'module.exports = { addLocaleData, translationMessages };',
				'exports.formatTranslationMessages = formatTranslationMessages;',
			].join('\n'),
		});
		const receipt = engine.exportedNames('i18n.js');
		expect(receipt.state).toBe('partial');
		// No CommonJS name is claimed: the engine does not analyze these.
		expect(receipt.results).toHaveLength(0);
		const forms = exportForms(receipt);
		expect(forms).toHaveLength(2);
		expect(forms.map((form) => form.detail.includes('module.exports = {'))).toContain(true);
		expect(
			forms.map((form) => form.detail.includes('exports.formatTranslationMessages =')),
		).toContain(true);
		// The q11 failure mode exactly: the require boundary was the only thing
		// named. It is still named, and it is no longer the only thing.
		expect(gaps(receipt).some((gap) => gap.reason === 'external-module-boundary')).toBe(true);
		assertCitable(engine, receipt);
	});

	test('a mixed module returns its ES exports and names the CommonJS assignment', () => {
		const engine = engineWith({
			'mixed.js': [
				'export const a = 1;',
				'export function b() {}',
				'module.exports.legacy = 2;',
			].join('\n'),
		});
		const receipt = engine.exportedNames('mixed.js');
		expect(receipt.state).toBe('partial');
		expect(receipt.results.map((result) => result.name).sort()).toEqual(['a', 'b']);
		const forms = exportForms(receipt);
		expect(forms).toHaveLength(1);
		expect(forms[0].detail).toContain('module.exports.legacy = 2');
		// 'legacy' is named as a site, never claimed as an exported name.
		expect(receipt.results.map((result) => result.name)).not.toContain('legacy');
		assertCitable(engine, receipt);
	});

	test('aliased and computed CommonJS forms are named too', () => {
		const engine = engineWith({
			'weird.js': [
				'const m = module;',
				'm.exports.aliased = 1;',
				'const target = module.exports;',
				'target.indirect = 2;',
				"const key = 'computed';",
				'exports[key] = 3;',
				'Object.assign(module.exports, { assigned: 4 });',
				'module[key] = 5;',
			].join('\n'),
		});
		const receipt = engine.exportedNames('weird.js');
		expect(receipt.state).toBe('partial');
		expect(receipt.results).toHaveLength(0);
		const details = exportForms(receipt).map((form) => form.detail);
		expect(details.some((detail) => detail.includes('m.exports.aliased = 1'))).toBe(true);
		expect(details.some((detail) => detail.includes('target.indirect = 2'))).toBe(true);
		expect(
			details.some(
				(detail) => detail.includes('exports[key] = 3') && detail.includes('computed key'),
			),
		).toBe(true);
		// The `Object.assign` receiver is an export construct as much as an
		// assignment is: it hands the exports object to an unanalyzed callee.
		expect(details.some((detail) => detail.includes("expression 'module.exports'"))).toBe(true);
		// A computed key on `module` itself may or may not be 'exports';
		// structure proves neither, so it is named for what it is.
		expect(
			gaps(receipt).filter(
				(gap) =>
					gap.reason === 'dynamic-member-access' && gap.detail.includes('module[key]'),
			),
		).toHaveLength(1);
		assertCitable(engine, receipt);
	});

	test("TypeScript 'export =' is named rather than answered as an empty module", () => {
		const engine = engineWith({ 'legacy.ts': 'const api = { run() {} };\nexport = api;' });
		const receipt = engine.exportedNames('legacy.ts');
		expect(receipt.state).toBe('partial');
		expect(receipt.results).toHaveLength(0);
		expect(exportForms(receipt)).toHaveLength(1);
		expect(exportForms(receipt)[0].detail).toContain("'export ='");
		assertCitable(engine, receipt);
	});

	test('a re-export of a CommonJS module names the form behind the barrel', () => {
		const engine = engineWith({
			'cjs.js': 'module.exports = { a: 1 };',
			'barrel.js': "export * from './cjs.js';\nexport const c = 2;",
		});
		const receipt = engine.exportedNames('barrel.js');
		expect(receipt.state).toBe('partial');
		expect(receipt.results.map((result) => result.name)).toEqual(['c']);
		const forms = exportForms(receipt);
		expect(forms).toHaveLength(1);
		expect(forms[0].site.file).toBe('cjs.js');
	});

	test('non-export uses of the CommonJS module object are not named', () => {
		// `module.hot` is webpack's HMR handle, not an export form. Naming it
		// would turn honest answers partial for no evidence.
		const engine = engineWith({
			'hmr.js': 'export const a = 1;\nif (module.hot) module.hot.accept();',
		});
		const receipt = engine.exportedNames('hmr.js');
		expect(receipt.state).toBe('complete');
		expect(receipt.results.map((result) => result.name)).toEqual(['a']);
	});
});

describe('ES modules are untouched by the D4 ruling', () => {
	const files = {
		'pure.ts': 'export const a = 1;\nexport function b() {}\nexport default a;\n',
		'barrel.ts': "export * from './pure.ts';\nexport const c = 2;\n",
	};

	// Integrity hashes pinned from the engine at HEAD, before the D4 change, on
	// exactly these sources. They cover the whole receipt (schema, state,
	// results, anchors, snapshot), so any drift in an ES answer breaks them.
	test('pure ES receipts are byte-identical to the pre-change engine', () => {
		const engine = engineWith(files);
		const pure = engine.exportedNames('pure.ts');
		const barrel = engine.exportedNames('barrel.ts');
		expect(pure.state).toBe('complete');
		expect(barrel.state).toBe('complete');
		expect(pure.snapshot).toBe(
			'b795000eba0c79d20b972451b436e2958f773f4080b7760c5f53cfdf9c6f4656',
		);
		expect(pure.integrity).toBe(
			'd1abd44a00fce8138708ff45747695b1aba20e02f64b4b5725c2b23402f6002f',
		);
		expect(barrel.integrity).toBe(
			'b6e8b04e48cdb4163c68f09d00e1ac9e7443da5bb3b9efebac6c1167fd241b48',
		);
		expect(engine.verify(pure)).toBe(true);
		expect(engine.verify(barrel)).toBe(true);
	});
});
