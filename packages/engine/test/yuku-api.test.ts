import { Analyzer, SymbolFlags } from 'yuku-analyzer';
import { expect, test } from 'vitest';

test('installed Yuku 0.8.4 runtime exposes the relied-on project and module API', () => {
	const analyzer = new Analyzer();
	const source = analyzer.addFile(
		'source.ts',
		'export let value = 0; export const fn = () => value++;',
	);
	const consumer = analyzer.addFile(
		'consumer.ts',
		"import { value as alias } from './source.ts'; alias;",
	);
	analyzer.link();
	const imported = consumer.rootScope.find('alias');
	const fn = source.rootScope.find('fn');
	expect(imported?.has(SymbolFlags.Import)).toBe(true);
	expect(imported && analyzer.definitionOf(imported)?.module.path).toBe('source.ts');
	expect(imported && analyzer.referencesOf(imported)).toHaveLength(2);
	expect(source.exportedNames()).toEqual(['value', 'fn']);
	const declarator =
		fn &&
		(source.parentOf(fn.declarations[0]) as { init: Parameters<typeof source.capturesOf>[0] });
	expect(declarator && source.capturesOf(declarator.init)[0].symbol.name).toBe('value');
	expect(typeof source.symbolOf).toBe('function');
	expect(typeof source.referenceOf).toBe('function');
	expect(typeof source.scopeOf).toBe('function');
	expect(typeof source.parentOf).toBe('function');
	expect(typeof source.resolve).toBe('function');
	expect(typeof source.walk).toBe('function');
});
