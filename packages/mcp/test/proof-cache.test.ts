import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import {
	GuesslessEngine,
	type Receipt,
	type SafeChangeImpactResult,
	verifySafeChangeSummary,
} from '../../engine/src/index.ts';
import { createGuesslessMcpServer } from '../src/index.ts';
import {
	PROOF_CACHE_CAPACITY,
	PROOF_CACHE_MAX_BYTES,
	SafeChangeProofCache,
} from '../src/proof-cache.ts';

type Harness = {
	client: Client;
	server: ReturnType<typeof createGuesslessMcpServer>;
	engine: GuesslessEngine;
};
const active: Harness[] = [];

async function harness(proofCache?: SafeChangeProofCache): Promise<Harness> {
	const engine = new GuesslessEngine();
	const server = createGuesslessMcpServer(engine, process.cwd(), proofCache);
	const client = new Client({ name: 'proof-cache-test', version: '0.0.1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	const value = { client, server, engine };
	active.push(value);
	return value;
}

async function call(
	value: Harness,
	name: string,
	arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
	return value.client.callTool({ name, arguments: arguments_ }) as Promise<CallToolResult>;
}

afterEach(async () => {
	for (const value of active.splice(0)) {
		await value.client.close();
		await value.server.close();
	}
});

describe('progressive safe-change proof cache', () => {
	test('keeps omitted view byte-identical and expands an opt-in summary exactly', async () => {
		const value = await harness();
		await call(value, 'guessless_add_file', {
			path: 'core.ts',
			source: 'export let target = 1; target++;',
		});
		await call(value, 'guessless_link', {});
		const target = value.engine.anchor('core.ts', 'target')!;
		const request = {
			snapshot: value.engine.snapshot(),
			intent: 'rename',
			target,
		} as const;
		const expected = value.engine.safeChangeImpact(request.snapshot, request.intent, target);
		const full = await call(value, 'guessless_safe_change_impact', request);
		expect(full.structuredContent).toEqual(expected);
		expect(full.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }]);

		const summary = await call(value, 'guessless_safe_change_impact', {
			...request,
			view: 'summary',
		});
		expect(verifySafeChangeSummary(summary.structuredContent)).toBe(true);
		expect(summary.structuredContent).toMatchObject({
			state: expected.state,
			request: expected.request,
			snapshot: expected.snapshot,
			proofHandle: expected.integrity,
		});
		const summaryText = (summary.content[0] as { text: string }).text;
		expect(summaryText).toContain('guessless.safe-change-summary/v1');
		expect(summaryText).toContain(`requestedSnapshot=${request.snapshot}`);
		expect(summaryText).toContain(`currentSnapshot=${expected.snapshot}`);
		expect(summaryText).toContain(`proof=${expected.integrity}`);
		expect(summaryText).not.toBe(JSON.stringify(summary.structuredContent));
		const expanded = await call(value, 'guessless_expand_safe_change_proof', {
			proofHandle: expected.integrity,
		});
		expect(expanded).toEqual(full);
	});

	test('uses bounded deterministic LRU storage without recomputation', () => {
		const receipts = Array.from({ length: 3 }, (_, index) => {
			const engine = new GuesslessEngine();
			engine.addFile(`file${index}.ts`, `export const value${index} = ${index};`);
			engine.link();
			return engine.safeChangeImpact(engine.snapshot(), 'rename', {
				file: `file${index}.ts`,
				name: `value${index}`,
				space: 'value',
			});
		});
		const firstBytes = Buffer.byteLength(JSON.stringify(receipts[0]), 'utf8');
		const secondBytes = Buffer.byteLength(JSON.stringify(receipts[1]), 'utf8');
		const cache = new SafeChangeProofCache(2, firstBytes + secondBytes);
		cache.set(receipts[0]!);
		cache.set(receipts[1]!);
		expect(cache.get(receipts[0]!.integrity)).toBe(JSON.stringify(receipts[0]));
		cache.set(receipts[2]!);
		expect(cache.get(receipts[1]!.integrity)).toBeUndefined();
		expect(cache.get(receipts[0]!.integrity)).toBe(JSON.stringify(receipts[0]));
		expect(cache.size).toBeLessThanOrEqual(2);
		expect(cache.bytes).toBeLessThanOrEqual(firstBytes + secondBytes);
		expect(PROOF_CACHE_CAPACITY).toBe(8);
		expect(PROOF_CACHE_MAX_BYTES).toBe(256 * 1024);
	});

	test('evicts by serialized-byte LRU and rejects an oversized exact proof', () => {
		const receipts = [0, 1].map((index) => {
			const engine = new GuesslessEngine();
			engine.addFile(`file${index}.ts`, `export const value${index} = ${index};`);
			engine.link();
			return engine.safeChangeImpact(engine.snapshot(), 'rename', {
				file: `file${index}.ts`,
				name: `value${index}`,
				space: 'value',
			});
		});
		const sizes = receipts.map((receipt) => Buffer.byteLength(JSON.stringify(receipt), 'utf8'));
		const byteCache = new SafeChangeProofCache(8, Math.max(...sizes));
		expect(byteCache.set(receipts[0]!)).toBe(true);
		expect(byteCache.set(receipts[1]!)).toBe(true);
		expect(byteCache.get(receipts[0]!.integrity)).toBeUndefined();
		expect(byteCache.get(receipts[1]!.integrity)).toBe(JSON.stringify(receipts[1]));
		const tiny = new SafeChangeProofCache(8, sizes[0]! - 1);
		expect(tiny.set(receipts[0]!)).toBe(false);
		expect(tiny.size).toBe(0);
		expect(tiny.bytes).toBe(0);
	});

	test('returns an oversized proof inline as the byte-identical full result', async () => {
		const value = await harness(new SafeChangeProofCache(8, 1));
		const source = 'export let target = 1; target++;';
		await call(value, 'guessless_add_file', { path: 'large.ts', source });
		await call(value, 'guessless_link', {});
		const request = {
			snapshot: value.engine.snapshot(),
			intent: 'rename',
			target: { file: 'large.ts', name: 'target', space: 'value' },
		} as const;
		const full = await call(value, 'guessless_safe_change_impact', request);
		expect(Buffer.byteLength(JSON.stringify(full.structuredContent), 'utf8')).toBeGreaterThan(
			1,
		);
		const requestedSummary = await call(value, 'guessless_safe_change_impact', {
			...request,
			view: 'summary',
		});
		expect(requestedSummary).toEqual(full);
	});

	test('strictly refuses unknown, evicted, and cross-instance handles', async () => {
		const first = await harness();
		const second = await harness();
		const receipts: Receipt<SafeChangeImpactResult>[] = [];
		for (let index = 0; index <= PROOF_CACHE_CAPACITY; index++) {
			await call(first, 'guessless_add_file', {
				path: `file${index}.ts`,
				source: `export const value${index} = ${index};`,
			});
		}
		await call(first, 'guessless_link', {});
		for (let index = 0; index <= PROOF_CACHE_CAPACITY; index++) {
			const summary = await call(first, 'guessless_safe_change_impact', {
				snapshot: first.engine.snapshot(),
				intent: 'rename',
				target: { file: `file${index}.ts`, name: `value${index}`, space: 'value' },
				view: 'summary',
			});
			receipts.push({
				integrity: summary.structuredContent?.proofHandle,
			} as Receipt<SafeChangeImpactResult>);
		}
		const evicted = receipts[0]!.integrity;
		for (const value of [
			await call(first, 'guessless_expand_safe_change_proof', { proofHandle: evicted }),
			await call(second, 'guessless_expand_safe_change_proof', {
				proofHandle: receipts.at(-1)!.integrity,
			}),
		])
			expect(value.structuredContent).toEqual({
				schema: 'guessless.proof-expansion/v1',
				state: 'refused',
				proofHandle: value.structuredContent?.proofHandle,
				reason: 'unknown-proof-handle',
				detail: 'Proof handle is unknown or was evicted from this server instance.',
			});
	});
});
