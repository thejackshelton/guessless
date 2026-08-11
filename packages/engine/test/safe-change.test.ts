import { describe, expect, test } from 'vitest';
import {
	GuesslessEngine,
	SAFE_CHANGE_ROLES,
	sha256,
	verifyReceipt,
	type SafeChangeImpactResult,
	type SymbolAnchor,
} from '../src/index.ts';

function linked(files: Record<string, string>): GuesslessEngine {
	const engine = new GuesslessEngine();
	for (const [path, source] of Object.entries(files)) engine.addFile(path, source);
	engine.link();
	return engine;
}

function assertResolvable(engine: GuesslessEngine, results: readonly SafeChangeImpactResult[]) {
	for (const result of results) {
		expect(engine.resolve(result.site)).not.toBeNull();
		expect(result.roles.length).toBeGreaterThan(0);
		expect(new Set(result.roles).size).toBe(result.roles.length);
		for (const role of result.roles) expect(SAFE_CHANGE_ROLES).toContain(role);
		for (const witness of result.witness) expect(engine.resolve(witness)).not.toBeNull();
	}
}

describe('safeChangeImpact', () => {
	test('reports structural declaration, reference, access, call, import, alias, namespace, export, and barrel roles', () => {
		const engine = linked({
			'core.ts': [
				'export let value = 0;',
				'value;',
				'value = 1;',
				'value++;',
				'export function leaf(): void {}',
				'export function entry(): void { leaf(); }',
			].join('\n'),
			'alias.ts': "import { value as renamed, entry as run } from './core';\nrenamed; run();",
			'namespace.ts': "import * as core from './core';\ncore.value; core.entry();",
			'barrel.ts': "export { value as barrelValue, entry as barrelEntry } from './core';",
			'consumer.ts':
				"import { barrelValue as consumed, barrelEntry } from './barrel';\nconsumed; barrelEntry();",
		});
		const value = engine.anchor('core.ts', 'value')!;
		const receipt = engine.safeChangeImpact(engine.snapshot(), 'rename', value);
		expect(receipt.state).toBe('complete');
		expect(engine.verify(receipt)).toBe(true);
		assertResolvable(engine, receipt.results);
		const roles = new Set(receipt.results.flatMap((result) => result.roles));
		for (const role of [
			'declaration',
			'reference',
			'read',
			'write',
			'read-write',
			'import',
			'alias',
			'namespace',
			'export',
			'barrel',
		] as const)
			expect(roles, `missing ${role}`).toContain(role);
		const entry = engine.safeChangeImpact(engine.snapshot(), 'delete', {
			file: 'core.ts',
			name: 'entry',
			space: 'value',
		});
		expect(entry.state).toBe('complete');
		expect(entry.results.some((result) => result.roles.includes('call'))).toBe(true);
	});

	test('returns the downstream entry-point slice with full resolvable witnesses', () => {
		const engine = linked({
			'leaf.ts': 'export function leaf(): void {}',
			'middle.ts':
				"import { leaf } from './leaf'; export function middle(): void { leaf(); }",
			'entry.ts':
				"import { middle } from './middle'; export function entry(): void { middle(); }",
		});
		const receipt = engine.safeChangeImpact(engine.snapshot(), 'entry-point', {
			file: 'entry.ts',
			name: 'entry',
			space: 'value',
		});
		expect(receipt.state).toBe('complete');
		expect(receipt.results.some((result) => result.roles.includes('declaration'))).toBe(true);
		const witnessed = receipt.results.filter((result) => result.roles.includes('witness'));
		expect(witnessed.length).toBeGreaterThanOrEqual(2);
		expect(witnessed.some((result) => result.site.file === 'leaf.ts')).toBe(true);
		for (const result of witnessed) expect(result.witness.length).toBeGreaterThan(0);
		assertResolvable(engine, receipt.results);
	});

	test('retains the exact deduplicated unresolved union for dynamic and computed boundaries', () => {
		const engine = linked({
			'core.ts': 'export const target = 1;',
			'dynamic.ts': [
				"import * as core from './core';",
				'declare const key: string;',
				'core[key];',
				"core['target'];",
			].join('\n'),
		});
		const target = engine.anchor('core.ts', 'target')!;
		const primitive = engine.referencesOf(target);
		const impact = engine.safeChangeImpact(engine.snapshot(), 'rename', target);
		expect(primitive.state).toBe('partial');
		expect(impact.state).toBe('partial');
		if (primitive.state !== 'partial' || impact.state !== 'partial') return;
		expect(impact.unresolved.map((item) => item.reason)).toContain('dynamic-member-access');
		expect(
			impact.results.some(
				(result) => result.site.file === 'dynamic.ts' && result.roles.includes('namespace'),
			),
		).toBe(true);
		const identity = (item: { site: SymbolAnchor; reason: string }) =>
			`${sha256(item.site)}:${item.reason}`;
		expect(impact.unresolved.map(identity).sort()).toEqual(
			[...new Set(primitive.unresolved.map(identity))].sort(),
		);
		expect(new Set(impact.unresolved.map(identity)).size).toBe(impact.unresolved.length);
		for (const item of impact.unresolved) expect(engine.resolve(item.site)).not.toBeNull();
	});

	test('refuses stale snapshots before target resolution and rejects changed snapshots', () => {
		const engine = linked({ 'source.ts': 'export const stable = 1;' });
		const snapshot = engine.snapshot();
		const missing = {
			schema: 'guessless.symbol-anchor/v1' as const,
			file: 'missing.ts',
			semanticPath: ['symbol:missing'],
			fingerprint: '0'.repeat(64),
		};
		expect(engine.safeChangeImpact('1'.repeat(64), 'rename', missing)).toMatchObject({
			state: 'refused',
			reason: 'stale-snapshot',
			results: [],
		});
		const stable = engine.anchor('source.ts', 'stable')!;
		engine.addFile('changed.ts', 'export const changed = 2;');
		engine.link();
		const changed = engine.safeChangeImpact(snapshot, 'delete', stable);
		expect(changed).toMatchObject({ state: 'refused', reason: 'stale-snapshot', results: [] });
		expect(verifyReceipt(changed, engine.snapshot())).toBe(true);
	});

	test('fails closed for missing, ambiguous, and stale selectors without safety claims', () => {
		const engine = linked({
			'a.ts': 'export const duplicate = 1;',
			'b.ts': 'export const duplicate = 2;',
			'barrel.ts': "export * from './a'; export * from './b';",
		});
		const missing = engine.safeChangeImpact(engine.snapshot(), 'rename', {
			file: 'barrel.ts',
			name: 'missing',
			space: 'value',
		});
		expect(missing).toMatchObject({ state: 'refused', reason: 'unresolved-symbol' });
		const ambiguous = engine.safeChangeImpact(engine.snapshot(), 'rename', {
			file: 'barrel.ts',
			name: 'duplicate',
			space: 'value',
		});
		expect(ambiguous).toMatchObject({
			state: 'refused',
			reason: 'ambiguous-definition',
			results: [],
		});
		expect(JSON.stringify(ambiguous)).not.toMatch(/"safe"/i);
		const anchor = engine.anchor('a.ts', 'duplicate')!;
		engine.removeFile('a.ts');
		engine.link();
		expect(engine.safeChangeImpact(engine.snapshot(), 'delete', anchor)).toMatchObject({
			state: 'refused',
			reason: 'unresolved-symbol',
		});
	});
});
