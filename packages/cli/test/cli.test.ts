import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
	GuesslessEngine,
	makeReceipt,
	type QueryRequest,
	type Receipt,
} from '../../engine/src/index.ts';
import { executeCommand } from '../src/index.ts';

const rootDir = resolve(import.meta.dirname, '../../..');
const cliPath = join(rootDir, 'packages/cli/dist/cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'guessless-cli-'));

const source = [
	'export let target = 1;',
	'target;',
	'target = 2;',
	'export interface TypeOnly { value: number }',
	'export namespace Names { export const item = 1; }',
	'export function makeClosure() { return () => target; }',
	'export function leaf(): void {}',
	'export function entry(): void { leaf(); }',
	'export function partial(): void { missing(); }',
	'export function scoped(): number { const local = 1; return local; }',
].join('\n');
const inputs = [{ path: 'source.ts', source }];

type ProcessResult = { status: number | null; stdout: string; stderr: string };

beforeAll(() => {
	execFileSync('pnpm', ['build'], { cwd: rootDir, stdio: 'ignore' });
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function engineFor(files = inputs): GuesslessEngine {
	const engine = new GuesslessEngine();
	for (const file of files) {
		const added = engine.addFile(file.path, file.source);
		if ('schema' in added) throw new Error(`unexpected fixture refusal for ${file.path}`);
	}
	engine.link();
	return engine;
}

function dispatch(engine: GuesslessEngine, request: QueryRequest): Receipt<unknown> {
	switch (request.kind) {
		case 'definitionOf':
			return engine.definitionOf(request.target);
		case 'referencesOf':
			return engine.referencesOf(request.target);
		case 'readsOf':
			return engine.readsOf(request.target);
		case 'writesOf':
			return engine.writesOf(request.target);
		case 'exportedNames':
			return engine.exportedNames(request.file);
		case 'capturesOf':
			return engine.capturesOf(request.target);
		case 'resolveBinding':
			return engine.resolveBinding(
				request.file,
				request.name,
				request.space,
				request.scope ?? undefined,
			);
		case 'reachableFrom':
			return engine.reachableFrom(request.target);
		case 'reaches':
			return engine.reaches(request.target);
		default:
			throw new Error('test request must be a query');
	}
}

function run(command: string, document: string, mode: 'stdin' | 'file' = 'stdin'): ProcessResult {
	if (mode === 'stdin') {
		const result = spawnSync(cliPath, [command, '-'], { cwd: rootDir, input: document });
		return {
			status: result.status,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}
	const path = join(scratch, `input-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(path, document);
	const result = spawnSync(cliPath, [command, path], { cwd: rootDir });
	return {
		status: result.status,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function expectExactProcess(actual: ProcessResult, expected: Receipt<unknown>, exitCode = 0): void {
	expect(actual.status).toBe(exitCode);
	expect(actual.stdout).toBe(`${JSON.stringify(expected)}\n`);
	expect(JSON.parse(actual.stdout)).toEqual(expected);
}

describe('guessless CLI', () => {
	test('builds an executable shebang entry and matches library execution', () => {
		expect(readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(statSync(cliPath).mode & 0o111).not.toBe(0);
		const engine = engineFor();
		const request = { kind: 'exportedNames', file: 'source.ts' } as const;
		const document = JSON.stringify({ inputs, request });
		const processResult = run('query', document);
		const libraryResult = executeCommand('query', document);
		expect(processResult).toEqual({
			status: libraryResult.exitCode,
			stdout: libraryResult.stdout,
			stderr: libraryResult.stderr,
		});
		expectExactProcess(processResult, engine.exportedNames('source.ts'));
	});

	test('dispatches every query and all five spaces as exact deterministic receipts', () => {
		const engine = engineFor();
		const target = engine.anchor('source.ts', 'target')!;
		const closure = engine.anchor('source.ts', 'makeClosure')!;
		const entry = engine.anchor('source.ts', 'entry')!;
		const local = engine.anchor('source.ts', 'local')!;
		const requests: QueryRequest[] = [
			{ kind: 'definitionOf', target },
			{ kind: 'referencesOf', target },
			{ kind: 'readsOf', target },
			{ kind: 'writesOf', target },
			{ kind: 'exportedNames', file: 'source.ts' },
			{ kind: 'capturesOf', target: closure },
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'target',
				space: 'value',
				scope: null,
			},
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'TypeOnly',
				space: 'type',
				scope: null,
			},
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'Names',
				space: 'namespace',
				scope: null,
			},
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'target',
				space: 'typeof',
				scope: null,
			},
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'target',
				space: 'any',
				scope: null,
			},
			{
				kind: 'resolveBinding',
				file: 'source.ts',
				name: 'local',
				space: 'value',
				scope: local,
			},
			{ kind: 'reachableFrom', target: entry },
			{ kind: 'reaches', target: entry },
		];
		for (const request of requests) {
			const expected = dispatch(engine, request);
			const document = JSON.stringify({ inputs, request });
			const first = run('query', document);
			const second = run('query', document);
			expectExactProcess(first, expected);
			expect(second).toEqual(first);
			for (const result of expected.results) {
				const record = result as {
					symbol?: Parameters<GuesslessEngine['resolve']>[0];
					witness?: Parameters<GuesslessEngine['resolve']>[0][];
				};
				if (record.symbol !== undefined)
					expect(engine.resolve(record.symbol)).not.toBeNull();
				for (const site of record.witness ?? [])
					expect(engine.resolve(site)).not.toBeNull();
			}
		}
		const optionalScopeRequest = {
			kind: 'resolveBinding',
			file: 'source.ts',
			name: 'target',
			space: 'value',
		};
		expectExactProcess(
			run('query', JSON.stringify({ inputs, request: optionalScopeRequest })),
			engine.resolveBinding('source.ts', 'target', 'value'),
		);
		const emptyRequest = {
			kind: 'resolveBinding',
			file: 'source.ts',
			name: 'missing',
			space: 'any',
		};
		const empty = engine.resolveBinding('source.ts', 'missing', 'any');
		expectExactProcess(run('query', JSON.stringify({ inputs, request: emptyRequest })), empty);
		expect(empty.state).toBe('complete');
		expect(empty.results).toEqual([]);
	});

	test('preserves complete, partial, refused, gaps, and stdin/file parity', () => {
		const engine = engineFor();
		const target = engine.anchor('source.ts', 'target')!;
		const partialTarget = engine.anchor('source.ts', 'partial')!;
		const staleTarget = { ...target, file: 'missing.ts' };
		const completeRequest = { kind: 'definitionOf', target } as const;
		const partialRequest = { kind: 'reaches', target: partialTarget } as const;
		const refusedRequest = { kind: 'definitionOf', target: staleTarget } as const;
		for (const request of [completeRequest, partialRequest, refusedRequest]) {
			const expected = dispatch(engine, request);
			const document = JSON.stringify({ inputs, request });
			const stdin = run('query', document, 'stdin');
			const file = run('query', document, 'file');
			expectExactProcess(stdin, expected);
			expect(file).toEqual(stdin);
		}
		const partial = dispatch(engine, partialRequest);
		expect(partial.state).toBe('partial');
		if (partial.state !== 'partial') throw new Error('expected partial fixture');
		for (const gap of partial.unresolved) expect(engine.resolve(gap.site)).not.toBeNull();
		expect(dispatch(engine, refusedRequest).state).toBe('refused');
	});

	test('propagates unsupported input refusals and validates before engine execution', () => {
		const engine = new GuesslessEngine();
		const refusal = engine.addFile('unsupported.py', 'value = 1');
		if (!('schema' in refusal)) throw new Error('expected unsupported-language refusal');
		const validEngine = engineFor();
		const target = validEngine.anchor('source.ts', 'target')!;
		const document = JSON.stringify({
			inputs: [{ path: 'unsupported.py', source: 'value = 1' }],
			request: { kind: 'definitionOf', target },
		});
		const actual = run('query', document);
		expectExactProcess(actual, refusal, 1);
		expect(actual.stderr).toContain('refused');

		for (const malformed of [
			`${JSON.stringify({ inputs, request: { kind: 'exportedNames', file: 'source.ts' } })} true`,
			JSON.stringify({
				inputs: [...inputs, inputs[0]],
				request: { kind: 'exportedNames', file: 'source.ts' },
			}),
			JSON.stringify({ inputs, request: { kind: 'unknown' } }),
			JSON.stringify({ inputs, request: { kind: 'addFile', file: 'unsupported.py' } }),
			JSON.stringify({
				inputs,
				request: { kind: 'exportedNames', file: 'source.ts', extra: true },
			}),
			JSON.stringify({
				inputs: [{ path: 'unsupported.py', source: '' }],
				request: { kind: 'unknown' },
			}),
		]) {
			const result = run('query', malformed);
			expect(result.status).toBe(2);
			expect(result.stdout).toBe('');
			expect(result.stderr).not.toBe('');
		}
		for (const args of [
			['unknown', '-'],
			['query', '-', '--extra'],
		]) {
			const result = spawnSync(cliPath, args, { cwd: rootDir, input: '{}' });
			expect(result.status).toBe(2);
			expect(result.stdout.toString()).toBe('');
			expect(result.stderr.toString()).not.toBe('');
		}
	});

	test('reproduces only full canonical receipt identity', () => {
		const engine = engineFor();
		const target = engine.anchor('source.ts', 'target')!;
		const request = { kind: 'definitionOf', target } as const;
		const receipt = engine.definitionOf(target);
		const exactDocument = JSON.stringify({ inputs, receipt });
		expectExactProcess(run('reproduce', exactDocument), receipt);

		const staleInputs = [{ path: 'source.ts', source: `${source}\n` }];
		const stale = run('reproduce', JSON.stringify({ inputs: staleInputs, receipt }));
		expect(stale.status).toBe(1);
		expect(stale.stderr).toContain('does not reproduce canonically');
		const staleEngine = engineFor(staleInputs);
		expect(JSON.parse(stale.stdout)).toEqual(dispatch(staleEngine, request));

		const tampered = { ...receipt, integrity: '0'.repeat(64) };
		const tamperedResult = run('reproduce', JSON.stringify({ inputs, receipt: tampered }));
		expect(tamperedResult.status).toBe(2);
		expect(tamperedResult.stdout).toBe('');
		expect(tamperedResult.stderr).toContain('integrity');
		const requestDivergent = {
			...receipt,
			request: { kind: 'exportedNames', file: 'source.ts' },
		};
		const requestDivergentResult = run(
			'reproduce',
			JSON.stringify({ inputs, receipt: requestDivergent }),
		);
		expect(requestDivergentResult.status).toBe(2);
		expect(requestDivergentResult.stdout).toBe('');
		expect(requestDivergentResult.stderr).toContain('integrity');

		const { integrity: _integrity, ...unsigned } = receipt;
		const divergent = makeReceipt({ ...unsigned, results: [] });
		const divergentResult = run('reproduce', JSON.stringify({ inputs, receipt: divergent }));
		expect(divergentResult.status).toBe(1);
		expect(JSON.parse(divergentResult.stdout)).toEqual(receipt);
		expect(divergentResult.stderr).toContain('does not reproduce canonically');
	});

	test('reproduces freshly generated addFile refusals through stdin and files', () => {
		const unsupportedInputs = [{ path: 'unsupported.py', source: 'value = 1' }];
		const validEngine = engineFor();
		const target = validEngine.anchor('source.ts', 'target')!;
		const queryDocument = JSON.stringify({
			inputs: unsupportedInputs,
			request: { kind: 'definitionOf', target },
		});
		const queried = run('query', queryDocument);
		expect(queried.status).toBe(1);
		const refusal = JSON.parse(queried.stdout) as Receipt<unknown>;
		if (refusal.state !== 'refused' || refusal.request.kind !== 'addFile')
			throw new Error('expected an addFile refusal fixture');

		const reproduceDocument = JSON.stringify({ inputs: unsupportedInputs, receipt: refusal });
		for (const mode of ['stdin', 'file'] as const) {
			const reproduced = run('reproduce', reproduceDocument, mode);
			expect(reproduced).toEqual({ status: 0, stdout: queried.stdout, stderr: '' });
		}
		const libraryResult = executeCommand('reproduce', reproduceDocument);
		expect(libraryResult).toEqual({ stdout: queried.stdout, stderr: '', exitCode: 0 });

		const tampered = { ...refusal, integrity: '0'.repeat(64) };
		const tamperedResult = run(
			'reproduce',
			JSON.stringify({ inputs: unsupportedInputs, receipt: tampered }),
		);
		expect(tamperedResult.status).toBe(2);
		expect(tamperedResult.stdout).toBe('');
		expect(tamperedResult.stderr).toContain('integrity');

		const { integrity: _integrity, ...unsigned } = refusal;
		const requestDivergent = makeReceipt({
			...unsigned,
			request: { kind: 'addFile', file: 'different.py' },
		});
		const divergentResult = run(
			'reproduce',
			JSON.stringify({ inputs: unsupportedInputs, receipt: requestDivergent }),
		);
		expect(divergentResult.status).toBe(1);
		expect(divergentResult.stdout).toBe(queried.stdout);
		expect(divergentResult.stderr).toContain('does not reproduce canonically');

		const snapshotDivergent = makeReceipt({ ...unsigned, snapshot: '0'.repeat(64) });
		const snapshotResult = run(
			'reproduce',
			JSON.stringify({ inputs: unsupportedInputs, receipt: snapshotDivergent }),
		);
		expect(snapshotResult.status).toBe(1);
		expect(snapshotResult.stdout).toBe(queried.stdout);

		const completeAddFile = makeReceipt({
			schema: 'guessless.receipt/v1',
			state: 'complete',
			query: 'addFile',
			request: refusal.request,
			snapshot: refusal.snapshot,
			results: [],
		});
		const completeResult = run(
			'reproduce',
			JSON.stringify({ inputs: unsupportedInputs, receipt: completeAddFile }),
		);
		expect(completeResult.status).toBe(2);
		expect(completeResult.stdout).toBe('');

		const supportedResult = run('reproduce', JSON.stringify({ inputs, receipt: refusal }));
		expect(supportedResult.status).toBe(1);
		expect(supportedResult.stdout).toBe('');
		expect(supportedResult.stderr).toContain('produced no addFile refusal');
	});

	test('preserves ordered input loading and the first addFile refusal', () => {
		const firstOrder = [
			...inputs,
			{ path: 'first.py', source: 'first = 1' },
			{ path: 'second.rb', source: 'second = 2' },
		];
		const secondOrder = [inputs[0], firstOrder[2], firstOrder[1]];
		const request = { kind: 'exportedNames', file: 'source.ts' } as const;
		const first = run('query', JSON.stringify({ inputs: firstOrder, request }));
		const second = run('query', JSON.stringify({ inputs: secondOrder, request }));
		expect(first.status).toBe(1);
		expect(second.status).toBe(1);
		expect(first.stdout).not.toBe(second.stdout);
		expect(JSON.parse(first.stdout).request).toEqual({ kind: 'addFile', file: 'first.py' });
		expect(JSON.parse(second.stdout).request).toEqual({ kind: 'addFile', file: 'second.rb' });

		const firstReceipt = JSON.parse(first.stdout) as Receipt<unknown>;
		const exact = run(
			'reproduce',
			JSON.stringify({ inputs: firstOrder, receipt: firstReceipt }),
		);
		expect(exact).toEqual({ status: 0, stdout: first.stdout, stderr: '' });
		const reordered = run(
			'reproduce',
			JSON.stringify({ inputs: secondOrder, receipt: firstReceipt }),
		);
		expect(reordered.status).toBe(1);
		expect(reordered.stdout).toBe(second.stdout);
		expect(reordered.stderr).toContain('does not reproduce canonically');
	});

	test('uses a fresh engine for every invocation without cross-run leakage', () => {
		const first = run(
			'query',
			JSON.stringify({ inputs, request: { kind: 'exportedNames', file: 'source.ts' } }),
		);
		expect(first.status).toBe(0);
		const secondEngine = new GuesslessEngine();
		secondEngine.link();
		const second = run(
			'query',
			JSON.stringify({ inputs: [], request: { kind: 'exportedNames', file: 'source.ts' } }),
		);
		expectExactProcess(second, secondEngine.exportedNames('source.ts'));
		expect(JSON.parse(second.stdout).state).toBe('refused');
	});
});
