import { expect, test } from 'vitest';
import { GuesslessEngine, verifyReceipt } from '../src/index.ts';

test('addFile and removeFile invalidate previously current receipts', () => {
	const engine = new GuesslessEngine();
	engine.addFile('source.ts', 'export const value = 1;');
	engine.addFile('consumer.ts', "import { value } from './source.ts'; value;");
	engine.link();
	const anchor = engine.anchor('source.ts', 'value')!;
	const beforeAdd = engine.referencesOf(anchor);
	expect(engine.verify(beforeAdd)).toBe(true);
	expect(verifyReceipt(beforeAdd)).toBe(true);
	engine.addFile('second.ts', "import { value } from './source.ts'; value;");
	engine.link();
	expect(engine.verify(beforeAdd)).toBe(false);
	const afterAdd = engine.referencesOf(anchor);
	expect(afterAdd.results).toHaveLength(2);
	expect(engine.verify(afterAdd)).toBe(true);
	engine.removeFile('second.ts');
	engine.link();
	expect(engine.verify(afterAdd)).toBe(false);
	expect(engine.verify(engine.referencesOf(anchor))).toBe(true);
});

test('catch and rest-pattern evidence invalidates after an executable source change', () => {
	const engine = new GuesslessEngine();
	const source = [
		'function leaf(): void {}',
		'class Value { get value(): number { leaf(); return 1; } }',
		'function consume(...[{ value }]: [Value]): void { void value; }',
		'export function entry(): void {',
		'  try { throw new Value(); } catch ({ value }) { void value; }',
		'  consume(new Value());',
		'}',
	].join('\n');
	engine.addFile('patterns.ts', source);
	engine.link();
	const receipt = engine.reaches(engine.anchor('patterns.ts', 'entry')!);
	expect(receipt.state).toBe('complete');
	expect(engine.verify(receipt)).toBe(true);
	engine.addFile('patterns.ts', source.replace('return 1', 'return 2'));
	engine.link();
	expect(engine.verify(receipt)).toBe(false);
	expect(engine.verify(engine.reaches(engine.anchor('patterns.ts', 'entry')!))).toBe(true);
});

test('cross-module rest evidence invalidates when the owning callee module changes', () => {
	const engine = new GuesslessEngine();
	const callee = [
		"import { Value } from './value.ts';",
		'export function consume(...[{ value }]: [Value]): void { void value; }',
	].join('\n');
	engine.addFile(
		'value.ts',
		'export function leaf(): void {} export class Value { get value(): number { leaf(); return 1; } }',
	);
	engine.addFile('callee.ts', callee);
	engine.addFile(
		'entry.ts',
		"import { consume } from './callee.ts'; import { Value } from './value.ts'; export function entry(): void { consume(new Value()); }",
	);
	engine.link();
	const anchor = engine.anchor('entry.ts', 'entry')!;
	const receipt = engine.reaches(anchor);
	expect(receipt.state).toBe('complete');
	expect(engine.verify(receipt)).toBe(true);
	engine.addFile('callee.ts', callee.replace('void value', 'valueOf(value)'));
	engine.link();
	expect(engine.verify(receipt)).toBe(false);
	const current = engine.reaches(anchor);
	expect(['complete', 'partial', 'refused']).toContain(current.state);
	expect(engine.verify(current)).toBe(true);
});
