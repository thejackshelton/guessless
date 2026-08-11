import { expect, test } from 'vitest';
import { GuesslessEngine } from '../src/index.ts';

test('symbol anchors survive line-only movement and fail closed after semantic change', () => {
	const engine = new GuesslessEngine();
	engine.addFile('a.ts', 'export const stable = () => 1;');
	const anchor = engine.anchor('a.ts', 'stable')!;
	expect(anchor.semanticPath.join('/')).toContain('symbol:stable');
	expect(JSON.stringify(anchor)).not.toMatch(/line|offset|byte/i);
	const resolved = engine.resolve(anchor);
	expect(resolved !== null && 'name' in resolved && resolved.name).toBe('stable');
	engine.addFile('a.ts', '\n\nexport const stable = () => 1;\n');
	const moved = engine.resolve(anchor);
	expect(moved !== null && 'name' in moved && moved.name).toBe('stable');
	engine.addFile('a.ts', 'export const stable = () => 2;');
	expect(engine.resolve(anchor)).toBeNull();
});

test('identical repeated site anchors are unique, resolvable, and movement-stable', () => {
	const engine = new GuesslessEngine();
	engine.addFile('repeat.ts', 'export let value = 0;\nvalue;\nvalue;');
	const symbol = engine.anchor('repeat.ts', 'value')!;
	const before = engine.referencesOf(symbol);
	expect(before.state).toBe('complete');
	expect(before.results).toHaveLength(2);
	expect(new Set(before.results.map((result) => JSON.stringify(result.site))).size).toBe(2);
	for (const result of before.results) expect(engine.resolve(result.site)).not.toBeNull();
	engine.addFile('repeat.ts', '\n\nexport let value = 0;\n\nvalue;\n\nvalue;\n');
	for (const result of before.results) expect(engine.resolve(result.site)).not.toBeNull();
	const after = engine.referencesOf(symbol);
	expect(after.results.map((result) => result.site)).toEqual(
		before.results.map((result) => result.site),
	);
});
