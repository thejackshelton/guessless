import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { createGuesslessMcpServer, GuesslessEngine } from '../src/index.ts';

type Harness = {
	client: Client;
	engine: InstanceType<typeof GuesslessEngine>;
	server: ReturnType<typeof createGuesslessMcpServer>;
};
const active: Harness[] = [];
type StdioHarness = { client: Client; transport: StdioClientTransport };
const activeStdio: StdioHarness[] = [];

async function createHarness(): Promise<Harness> {
	const engine = new GuesslessEngine();
	const server = createGuesslessMcpServer(engine);
	const client = new Client({ name: 'guessless-test-client', version: '0.0.1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	const harness = { client, engine, server };
	active.push(harness);
	return harness;
}

async function createStdioHarness(): Promise<StdioHarness> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
		stderr: 'pipe',
	});
	const client = new Client({ name: 'guessless-stdio-test-client', version: '0.0.1' });
	await client.connect(transport);
	const harness = { client, transport };
	activeStdio.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of active.splice(0)) {
		await harness.client.close();
		await harness.server.close();
	}
	for (const harness of activeStdio.splice(0))
		try {
			await harness.client.close();
		} catch {
			// A transport-close attribution test deliberately closes its process first.
		}
});

async function call(
	harness: Harness,
	name: string,
	args: Record<string, unknown>,
): Promise<CallToolResult> {
	return harness.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

function expectExactResult(
	result: Awaited<ReturnType<typeof call>>,
	expected: Record<string, unknown>,
): void {
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual(expected);
	expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);
	expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
		result.structuredContent,
	);
}

function decodedPageCursor(cursor: string): Record<string, unknown> {
	const [body] = cursor.split('.');
	return JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function legacyPageCursor(payload: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${body}.${createHash('sha256').update(`${payload.cache}:${body}`).digest('hex')}`;
}

async function addProgram(harness: Harness): Promise<void> {
	const source = [
		'export let target = 1;',
		'target;',
		'target = 2;',
		'export function makeClosure() { return () => target; }',
		'export function leaf(): void {}',
		'export function entry(): void { leaf(); }',
		'export function partial(): void { missing(); }',
	].join('\n');
	expectExactResult(await call(harness, 'guessless_add_file', { path: 'source.ts', source }), {
		kind: 'operation',
		operation: 'addFile',
		ok: true,
		file: 'source.ts',
	});
	const linked = await call(harness, 'guessless_link', {});
	expect(linked.isError).not.toBe(true);
	expect(linked.structuredContent).toMatchObject({
		kind: 'operation',
		operation: 'link',
		ok: true,
	});
	expect(linked.structuredContent).not.toHaveProperty('schema');
	expect(linked.structuredContent).not.toHaveProperty('integrity');
}

describe('@guessless/mcp', () => {
	test('publishes preparation, safe-change impact, legacy operations, and all nine primitive queries', async () => {
		const harness = await createHarness();
		const listed = await harness.client.listTools();
		expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
			[
				'guessless_add_file',
				'guessless_captures_of',
				'guessless_definition_of',
				'guessless_expand_safe_change_proof',
				'guessless_exported_names',
				'guessless_link',
				'guessless_prepare_snapshot',
				'guessless_reachable_from',
				'guessless_reaches',
				'guessless_reads_of',
				'guessless_references_of',
				'guessless_remove_file',
				'guessless_resolve_binding',
				'guessless_safe_change_impact',
				'guessless_safe_change_page',
				'guessless_writes_of',
			].sort(),
		);
	});

	test('returns every engine query receipt field-for-field through the transport', async () => {
		const harness = await createHarness();
		await addProgram(harness);
		const target = harness.engine.anchor('source.ts', 'target')!;
		const closure = harness.engine.anchor('source.ts', 'makeClosure')!;
		const entry = harness.engine.anchor('source.ts', 'entry')!;
		const cases = [
			['guessless_definition_of', { target }, harness.engine.definitionOf(target)],
			['guessless_references_of', { target }, harness.engine.referencesOf(target)],
			['guessless_reads_of', { target }, harness.engine.readsOf(target)],
			['guessless_writes_of', { target }, harness.engine.writesOf(target)],
			[
				'guessless_exported_names',
				{ file: 'source.ts' },
				harness.engine.exportedNames('source.ts'),
			],
			['guessless_captures_of', { target: closure }, harness.engine.capturesOf(closure)],
			[
				'guessless_resolve_binding',
				{ file: 'source.ts', name: 'target', space: 'value' },
				harness.engine.resolveBinding('source.ts', 'target', 'value'),
			],
			['guessless_reachable_from', { target: entry }, harness.engine.reachableFrom(entry)],
			['guessless_reaches', { target: entry }, harness.engine.reaches(entry)],
		] as const;
		for (const [name, args, expected] of cases)
			expectExactResult(
				await call(harness, name, args),
				expected as unknown as Record<string, unknown>,
			);
	});

	test('delivers bounded paged safe-change heads, semantic pages, and exact proof pages', async () => {
		const harness = await createHarness();
		await addProgram(harness);
		const snapshot = harness.engine.snapshot();
		const target = harness.engine.anchor('source.ts', 'target')!;
		const full = await call(harness, 'guessless_safe_change_impact', {
			snapshot,
			intent: 'rename',
			target,
		});
		const paged = await call(harness, 'guessless_safe_change_impact', {
			snapshot,
			intent: 'rename',
			target,
			view: 'paged',
		});
		expect(Buffer.byteLength(JSON.stringify(paged))).toBeLessThanOrEqual(8_192);
		expect(paged.structuredContent).toMatchObject({
			schema: 'guessless.safe-change-paged/v1',
			state: full.structuredContent?.state,
			proofHandle: full.structuredContent?.integrity,
			snapshot,
		});
		const head = paged.structuredContent as {
			proofHandle: string;
			semantic: { firstCursor: string };
			proof: { firstCursor: string };
		};
		const semantic = await call(harness, 'guessless_safe_change_page', {
			pageHandle: head.proofHandle,
			stream: 'semantic',
			cursor: head.semantic.firstCursor,
		});
		expect(Buffer.byteLength(JSON.stringify(semantic))).toBeLessThanOrEqual(8_192);
		expect(semantic.structuredContent).toMatchObject({ state: 'complete', coverage: 'full' });
		const cursorPayload = decodedPageCursor(head.semantic.firstCursor);
		for (const mutation of [
			{ ...cursorPayload, cache: '0'.repeat(32) },
			{ ...cursorPayload, handle: '0'.repeat(64) },
			{ ...cursorPayload, stream: 'proof' },
			{ ...cursorPayload, filter: '0'.repeat(64) },
			{ ...cursorPayload, index: 1 },
			{ ...cursorPayload, digest: '0'.repeat(64) },
			Object.fromEntries(Object.entries(cursorPayload).reverse()),
			{ ...cursorPayload, extra: true },
		]) {
			const refused = await call(harness, 'guessless_safe_change_page', {
				pageHandle: head.proofHandle,
				stream: 'semantic',
				cursor: legacyPageCursor(mutation),
			});
			expect(refused.structuredContent).toMatchObject({
				state: 'refused',
				reason: 'invalid-page-cursor',
			});
		}
		const proofChunks: Buffer[] = [];
		let cursor: string | undefined = head.proof.firstCursor;
		do {
			const page = await call(harness, 'guessless_safe_change_page', {
				pageHandle: head.proofHandle,
				stream: 'proof',
				cursor,
			});
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8_192);
			const body = page.structuredContent as {
				chunkBase64: string;
				nextCursor: string | null;
			};
			proofChunks.push(Buffer.from(body.chunkBase64, 'base64'));
			cursor = body.nextCursor ?? undefined;
		} while (cursor !== undefined);
		expect(Buffer.concat(proofChunks).toString('utf8')).toBe(
			JSON.stringify(full.structuredContent),
		);
	});

	test('preserves all five binding spaces, defaults, scopes, and empty results', async () => {
		const harness = await createHarness();
		const source = [
			'export const value = 1;',
			'export interface TypeOnly { value: number }',
			'export namespace Names { export const item = 1; }',
			'export function scoped(): number { const local = 1; return local; }',
		].join('\n');
		await call(harness, 'guessless_add_file', { path: 'bindings.ts', source });
		await call(harness, 'guessless_add_file', {
			path: 'foreign.ts',
			source: 'export const foreign = 1;',
		});
		await call(harness, 'guessless_link', {});
		const requests = [
			['value', 'value'],
			['type', 'TypeOnly'],
			['namespace', 'Names'],
			['typeof', 'value'],
			['any', 'value'],
		] as const;
		for (const [space, name] of requests) {
			const expected = harness.engine.resolveBinding('bindings.ts', name, space);
			const transported = await call(harness, 'guessless_resolve_binding', {
				file: 'bindings.ts',
				name,
				space,
			});
			expectExactResult(transported, expected as unknown as Record<string, unknown>);
			expect(transported.structuredContent?.request).toMatchObject({ space });
		}

		const defaulted = await call(harness, 'guessless_resolve_binding', {
			file: 'bindings.ts',
			name: 'value',
		});
		expectExactResult(
			defaulted,
			harness.engine.resolveBinding('bindings.ts', 'value') as unknown as Record<
				string,
				unknown
			>,
		);
		expect(defaulted.structuredContent?.request).toMatchObject({ space: 'value' });

		const local = harness.engine.anchor('bindings.ts', 'local')!;
		const scoped = await call(harness, 'guessless_resolve_binding', {
			file: 'bindings.ts',
			name: 'local',
			space: 'value',
			from: local,
		});
		expectExactResult(
			scoped,
			harness.engine.resolveBinding(
				'bindings.ts',
				'local',
				'value',
				local,
			) as unknown as Record<string, unknown>,
		);

		const empty = await call(harness, 'guessless_resolve_binding', {
			file: 'bindings.ts',
			name: 'missing',
			space: 'any',
		});
		expectExactResult(
			empty,
			harness.engine.resolveBinding('bindings.ts', 'missing', 'any') as unknown as Record<
				string,
				unknown
			>,
		);
		expect(empty.structuredContent?.state).toBe('complete');
		expect(empty.structuredContent?.results).toEqual([]);

		const foreign = harness.engine.anchor('foreign.ts', 'foreign')!;
		const foreignScope = await call(harness, 'guessless_resolve_binding', {
			file: 'bindings.ts',
			name: 'value',
			space: 'value',
			from: foreign,
		});
		expectExactResult(
			foreignScope,
			harness.engine.resolveBinding(
				'bindings.ts',
				'value',
				'value',
				foreign,
			) as unknown as Record<string, unknown>,
		);
		expect(foreignScope.structuredContent?.state).toBe('refused');

		await call(harness, 'guessless_add_file', {
			path: 'bindings.ts',
			source: 'export const replacement = 1;',
		});
		await call(harness, 'guessless_link', {});
		const staleScope = await call(harness, 'guessless_resolve_binding', {
			file: 'bindings.ts',
			name: 'value',
			space: 'value',
			from: local,
		});
		expectExactResult(
			staleScope,
			harness.engine.resolveBinding(
				'bindings.ts',
				'value',
				'value',
				local,
			) as unknown as Record<string, unknown>,
		);
		expect(staleScope.structuredContent?.state).toBe('refused');
	});

	test('rejects unknown binding spaces and extra fields without narrowing valid strings', async () => {
		const harness = await createHarness();
		await call(harness, 'guessless_add_file', {
			path: 'source.ts',
			source: 'export const value = 1;',
		});
		await call(harness, 'guessless_link', {});
		for (const arguments_ of [
			{ file: 'source.ts', name: 'value', space: 'class' },
			{ file: 'source.ts', name: 'value', space: 'value', extra: true },
		])
			expect((await call(harness, 'guessless_resolve_binding', arguments_)).isError).toBe(
				true,
			);

		const emptyName = await call(harness, 'guessless_resolve_binding', {
			file: 'source.ts',
			name: '',
			space: 'any',
		});
		expectExactResult(
			emptyName,
			harness.engine.resolveBinding('source.ts', '', 'any') as unknown as Record<
				string,
				unknown
			>,
		);
		const emptyFile = await call(harness, 'guessless_exported_names', { file: '' });
		expectExactResult(
			emptyFile,
			harness.engine.exportedNames('') as unknown as Record<string, unknown>,
		);
		const target = harness.engine.anchor('source.ts', 'value')!;
		const emptyAnchorFile = { ...target, file: '' };
		const emptyAnchor = await call(harness, 'guessless_definition_of', {
			target: emptyAnchorFile,
		});
		expectExactResult(
			emptyAnchor,
			harness.engine.definitionOf(emptyAnchorFile) as unknown as Record<string, unknown>,
		);
		const emptyAdd = await call(harness, 'guessless_add_file', { path: '', source: '' });
		expectExactResult(
			emptyAdd,
			harness.engine.addFile('', '') as unknown as Record<string, unknown>,
		);
	});

	test('preserves complete, partial, refused, and stale snapshot semantics', async () => {
		const harness = await createHarness();
		await addProgram(harness);
		const target = harness.engine.anchor('source.ts', 'target')!;
		const partialTarget = harness.engine.anchor('source.ts', 'partial')!;
		const complete = await call(harness, 'guessless_definition_of', { target });
		expect(complete.structuredContent?.state).toBe('complete');
		const partial = await call(harness, 'guessless_reaches', { target: partialTarget });
		expect(partial.structuredContent?.state).toBe('partial');
		expect(partial.structuredContent?.unresolved).toBeDefined();

		const oldReceipt = complete.structuredContent!;
		expect(harness.engine.verify(oldReceipt)).toBe(true);
		await call(harness, 'guessless_add_file', {
			path: 'extra.ts',
			source: 'export const extra = true;',
		});
		await call(harness, 'guessless_link', {});
		expect(harness.engine.verify(oldReceipt)).toBe(false);
		const current = await call(harness, 'guessless_definition_of', { target });
		expect(current.structuredContent?.snapshot).not.toBe(oldReceipt.snapshot);

		await call(harness, 'guessless_remove_file', { path: 'source.ts' });
		await call(harness, 'guessless_link', {});
		const refused = await call(harness, 'guessless_definition_of', { target });
		expect(refused.structuredContent?.state).toBe('refused');
		expect(refused.structuredContent?.reason).toBe('unresolved-symbol');
		expectExactResult(
			refused,
			harness.engine.definitionOf(target) as unknown as Record<string, unknown>,
		);
	});

	test('rejects malformed input, propagates add refusal, and isolates server state', async () => {
		const first = await createHarness();
		const second = await createHarness();
		const malformed = await call(first, 'guessless_add_file', {
			path: 'bad.ts',
			source: 'export const bad = true;',
			extra: true,
		});
		expect(malformed.isError).toBe(true);
		expect(first.engine.module('bad.ts')).toBeUndefined();

		const unsupported = await call(first, 'guessless_add_file', {
			path: 'notes.py',
			source: 'value = 1',
		});
		const refusalEngine = new GuesslessEngine();
		const direct = refusalEngine.addFile('notes.py', 'value = 1');
		expect('schema' in direct).toBe(true);
		expectExactResult(unsupported, direct as unknown as Record<string, unknown>);
		expect(unsupported.structuredContent).not.toHaveProperty('operation');

		const malformedQuery = await call(first, 'guessless_definition_of', {
			target: {
				schema: 'guessless.symbol-anchor/v1',
				file: 'source.ts',
				semanticPath: ['symbol:target'],
				fingerprint: 'not-a-digest',
			},
		});
		expect(malformedQuery.isError).toBe(true);

		await call(first, 'guessless_add_file', {
			path: 'only-first.ts',
			source: 'export const value = 1;',
		});
		await call(first, 'guessless_link', {});
		await call(second, 'guessless_link', {});
		expect(first.engine.module('only-first.ts')).toBeDefined();
		expect(second.engine.module('only-first.ts')).toBeUndefined();
		const missing = await call(second, 'guessless_exported_names', {
			file: 'only-first.ts',
		});
		expect(missing.structuredContent?.state).toBe('refused');
	});

	test('atomically prepares portable canonical coverage with exact provenance and semantic parity', async () => {
		const harness = await createHarness();
		const sources = [
			{
				path: 'src\\api.ts',
				source: [
					'export let target = 1;',
					'target;',
					'target = 2;',
					'export function makeClosure() { return () => target; }',
					'export function leaf(): void {}',
					'export function entry(): void { leaf(); }',
				].join('\n'),
			},
			{
				path: 'src/consumer.ts',
				source: "import { target } from './api';\nexport const observed = target;",
			},
		] as const;
		const baseline = new GuesslessEngine();
		for (const source of sources)
			baseline.addFile(source.path.replace('\\', '/'), source.source);
		baseline.link();

		const prepared = await call(harness, 'guessless_prepare_snapshot', { sources });
		expectExactResult(prepared, {
			schema: 'guessless.prepared-snapshot/v1',
			state: 'complete',
			snapshot: baseline.snapshot(),
			coverage: [...sources]
				.map((source) => ({
					path: source.path.replace('\\', '/'),
					sourceSha256: createHash('sha256').update(source.source).digest('hex'),
				}))
				.sort((left, right) => left.path.localeCompare(right.path)),
			fileCount: 2,
		});

		const target = baseline.anchor('src/api.ts', 'target')!;
		const closure = baseline.anchor('src/api.ts', 'makeClosure')!;
		const entry = baseline.anchor('src/api.ts', 'entry')!;
		const cases = [
			['guessless_definition_of', { target }, baseline.definitionOf(target)],
			['guessless_references_of', { target }, baseline.referencesOf(target)],
			['guessless_reads_of', { target }, baseline.readsOf(target)],
			['guessless_writes_of', { target }, baseline.writesOf(target)],
			[
				'guessless_exported_names',
				{ file: 'src/api.ts' },
				baseline.exportedNames('src/api.ts'),
			],
			['guessless_captures_of', { target: closure }, baseline.capturesOf(closure)],
			[
				'guessless_resolve_binding',
				{ file: 'src/api.ts', name: 'target', space: 'value' },
				baseline.resolveBinding('src/api.ts', 'target', 'value'),
			],
			['guessless_reachable_from', { target: entry }, baseline.reachableFrom(entry)],
			['guessless_reaches', { target: entry }, baseline.reaches(entry)],
		] as const;
		for (const [name, args, expected] of cases)
			expectExactResult(
				await call(harness, name, args),
				expected as unknown as Record<string, unknown>,
			);
	});

	test('rejects unsafe, duplicate, unsupported, and malformed batches atomically and refuses stale anchors', async () => {
		const harness = await createHarness();
		const firstSource = 'export const stable = 1;';
		const first = await call(harness, 'guessless_prepare_snapshot', {
			sources: [{ path: 'src/stable.ts', source: firstSource }],
		});
		expect(first.structuredContent?.state).toBe('complete');
		const baseline = new GuesslessEngine();
		baseline.addFile('src/stable.ts', firstSource);
		baseline.link();
		const oldAnchor = baseline.anchor('src/stable.ts', 'stable')!;
		const before = await call(harness, 'guessless_definition_of', { target: oldAnchor });
		expect(before.structuredContent?.state).toBe('complete');

		for (const sources of [
			[{ path: '../escape.ts', source: '' }],
			[{ path: '/absolute.ts', source: '' }],
			[{ path: 'C:\\absolute.ts', source: '' }],
			[{ path: 'C:drive-relative.ts', source: '' }],
			[{ path: '//server/share.ts', source: '' }],
			[{ path: 'notes.py', source: '' }],
			[
				{ path: 'src/duplicate.ts', source: 'export const a = 1;' },
				{ path: 'src\\duplicate.ts', source: 'export const b = 1;' },
			],
		]) {
			const refused = await call(harness, 'guessless_prepare_snapshot', { sources });
			expect(refused.isError).not.toBe(true);
			expect(refused.structuredContent).toMatchObject({
				schema: 'guessless.prepared-snapshot/v1',
				state: 'refused',
				snapshot: first.structuredContent?.snapshot,
			});
			const after = await call(harness, 'guessless_definition_of', { target: oldAnchor });
			expect(after.structuredContent).toEqual(before.structuredContent);
		}

		for (const arguments_ of [
			{ sources: [] },
			{ sources: [{ path: '', source: '' }] },
			{ sources: [{ path: 'src/extra.ts', source: '', extra: true }] },
			{ sources: [{ path: 'src/extra.ts', source: '' }], extra: true },
		]) {
			const rejected = await call(harness, 'guessless_prepare_snapshot', arguments_);
			expect(rejected.isError).toBe(true);
			const after = await call(harness, 'guessless_definition_of', { target: oldAnchor });
			expect(after.structuredContent).toEqual(before.structuredContent);
		}

		await call(harness, 'guessless_prepare_snapshot', {
			sources: [{ path: 'src/stable.ts', source: 'export const replacement = 2;' }],
		});
		const stale = await call(harness, 'guessless_definition_of', { target: oldAnchor });
		expect(stale.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'unresolved-symbol',
		});
		expect(stale.structuredContent?.snapshot).not.toBe(first.structuredContent?.snapshot);
	});

	test('attributes lifecycle outcomes and completes 200 in-memory plus stdio calls with recovery', async () => {
		const memory = await createHarness();
		const source = 'export const delivered = 1;';
		const preparedMemory = await call(memory, 'guessless_prepare_snapshot', {
			sources: [{ path: 'src/delivered.ts', source }],
		});
		expect(preparedMemory.structuredContent?.state).toBe('complete');
		let successes = 0;
		for (let index = 0; index < 100; index += 1) {
			const result = await call(memory, 'guessless_exported_names', {
				file: 'src/delivered.ts',
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({ state: 'complete' });
			successes += 1;
		}

		const stdio = await createStdioHarness();
		const preparedStdio = (await stdio.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { sources: [{ path: 'src/delivered.ts', source }] },
		})) as CallToolResult;
		expect(preparedStdio.structuredContent).toEqual(preparedMemory.structuredContent);
		for (let index = 0; index < 100; index += 1) {
			const result = (await stdio.client.callTool({
				name: 'guessless_exported_names',
				arguments: { file: 'src/delivered.ts' },
			})) as CallToolResult;
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toMatchObject({
				state: 'complete',
				snapshot: preparedStdio.structuredContent?.snapshot,
			});
			successes += 1;
		}
		expect(successes).toBe(200);

		const schemaRejection = (await stdio.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { sources: [] },
		})) as CallToolResult;
		expect(schemaRejection.isError).toBe(true);
		const serverRefusal = (await stdio.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { sources: [{ path: '../unsafe.ts', source: '' }] },
		})) as CallToolResult;
		expect(serverRefusal.isError).not.toBe(true);
		expect(serverRefusal.structuredContent).toMatchObject({
			state: 'refused',
			snapshot: preparedStdio.structuredContent?.snapshot,
			reason: 'unsafe-path',
		});

		const abort = new AbortController();
		abort.abort();
		await expect(
			stdio.client.callTool(
				{
					name: 'guessless_exported_names',
					arguments: { file: 'src/delivered.ts' },
				},
				undefined,
				{ signal: abort.signal },
			),
		).rejects.toMatchObject({ name: 'AbortError' });

		const recovered = (await stdio.client.callTool({
			name: 'guessless_exported_names',
			arguments: { file: 'src/delivered.ts' },
		})) as CallToolResult;
		expect(recovered.isError).not.toBe(true);
		expect(recovered.structuredContent).toMatchObject({
			state: 'complete',
			snapshot: preparedStdio.structuredContent?.snapshot,
		});

		const closed = await createStdioHarness();
		await closed.transport.close();
		await expect(
			closed.client.callTool({
				name: 'guessless_exported_names',
				arguments: { file: 'src/delivered.ts' },
			}),
		).rejects.toThrow();
	});

	test('delivers every safe-change intent over stdio within two cold and one warm calls and refuses changed snapshots', async () => {
		const stdio = await createStdioHarness();
		const sources = [
			{
				path: 'leaf.ts',
				source: 'export function leaf(): void {}',
			},
			{
				path: 'entry.ts',
				source: [
					"import { leaf as dependency } from './leaf';",
					'export let value = 1;',
					'value++;',
					'export function entry(): void { dependency(); }',
				].join('\n'),
			},
		];
		let coldCalls = 0;
		const prepared = (await stdio.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { sources },
		})) as CallToolResult;
		coldCalls += 1;
		const snapshot = prepared.structuredContent?.snapshot as string;
		const rename = (await stdio.client.callTool({
			name: 'guessless_safe_change_impact',
			arguments: {
				snapshot,
				intent: 'rename',
				target: { file: 'entry.ts', name: 'value', space: 'value' },
			},
		})) as CallToolResult;
		coldCalls += 1;
		expect(coldCalls).toBeLessThanOrEqual(2);
		expect(rename.structuredContent).toMatchObject({
			state: 'complete',
			query: 'safeChangeImpact',
			snapshot,
		});

		for (const [intent, name] of [
			['delete', 'value'],
			['entry-point', 'entry'],
		] as const) {
			let warmCalls = 0;
			const result = (await stdio.client.callTool({
				name: 'guessless_safe_change_impact',
				arguments: {
					snapshot,
					intent,
					target: { file: 'entry.ts', name, space: 'value' },
				},
			})) as CallToolResult;
			warmCalls += 1;
			expect(warmCalls).toBeLessThanOrEqual(1);
			expect(result.structuredContent).toMatchObject({
				state: 'complete',
				query: 'safeChangeImpact',
				snapshot,
			});
			if (intent === 'entry-point') {
				const results = result.structuredContent?.results;
				expect(Array.isArray(results)).toBe(true);
				expect(
					(results as Array<{ roles: string[] }>).some((impact) =>
						impact.roles.includes('witness'),
					),
				).toBe(true);
			}
		}

		const changed = (await stdio.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: {
				sources: sources.map((source) =>
					source.path === 'entry.ts'
						? { ...source, source: `${source.source}\nexport const changed = true;` }
						: source,
				),
			},
		})) as CallToolResult;
		expect(changed.structuredContent?.snapshot).not.toBe(snapshot);
		const stale = (await stdio.client.callTool({
			name: 'guessless_safe_change_impact',
			arguments: {
				snapshot,
				intent: 'rename',
				target: { file: 'missing.ts', name: 'missing', space: 'value' },
			},
		})) as CallToolResult;
		expect(stale.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'stale-snapshot',
			results: [],
			snapshot: changed.structuredContent?.snapshot,
		});

		for (const arguments_ of [
			{ snapshot, intent: 'rename', target: { file: 'entry.ts', name: 'value' } },
			{
				snapshot,
				intent: 'rename',
				target: { file: 'entry.ts', name: 'value', space: 'value', extra: true },
			},
			{
				snapshot,
				intent: 'rename',
				target: { file: 'entry.ts', name: 'value', space: 'value' },
				extra: true,
			},
		]) {
			const rejected = (await stdio.client.callTool({
				name: 'guessless_safe_change_impact',
				arguments: arguments_,
			})) as CallToolResult;
			expect(rejected.isError).toBe(true);
		}
	});
});
