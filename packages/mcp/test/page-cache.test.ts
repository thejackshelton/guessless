import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
	GuesslessEngine,
	type Receipt,
	type SafeChangeImpactResult,
} from '../../engine/src/index.ts';
import {
	PAGED_CALL_TOOL_MAX_BYTES,
	SafeChangePageCache,
	completeCallToolResultBytes,
	makeSafeChangePagedBundle,
} from '../src/page-cache.ts';

function bundle() {
	const engine = new GuesslessEngine();
	engine.addFile(
		'source.ts',
		'export let target = 1; target; target = 2; export const alias = target;',
	);
	engine.link();
	const receipt = engine.safeChangeImpact(
		engine.snapshot(),
		'rename',
		engine.anchor('source.ts', 'target')!,
	);
	return { receipt, bundle: makeSafeChangePagedBundle(receipt) };
}

function expectRefusal(value: object, reason: string): void {
	expect(value).toMatchObject({
		schema: 'guessless.safe-change-page/v1',
		state: 'refused',
		reason,
	});
}

function decodedCursor(cursor: string): Record<string, unknown> {
	const [body] = cursor.split('.');
	return JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function legacyCursor(payload: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${body}.${createHash('sha256').update(`${payload.cache}:${body}`).digest('hex')}`;
}

describe('bounded safe-change page cache', () => {
	test('reconstructs ordered semantic facts and exact proof under every response bound', () => {
		const cache = new SafeChangePageCache();
		const input = bundle();
		const head = cache.set(input.bundle);
		expect(head).toHaveProperty('semantic');
		expect(completeCallToolResultBytes(head)).toBeLessThanOrEqual(PAGED_CALL_TOOL_MAX_BYTES);
		const committed = head as Exclude<typeof head, { reason: string }>;
		const facts: unknown[] = [];
		let cursor: string | undefined = committed.semantic.firstCursor;
		do {
			const page = cache.page({
				pageHandle: input.receipt.integrity,
				stream: 'semantic',
				cursor,
			}) as { facts: unknown[]; nextCursor: string | null };
			expect(completeCallToolResultBytes(page)).toBeLessThanOrEqual(
				PAGED_CALL_TOOL_MAX_BYTES,
			);
			facts.push(...page.facts);
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		expect(facts).toEqual(input.bundle.facts);
		const chunks: Buffer[] = [];
		cursor = committed.proof.firstCursor;
		do {
			const page = cache.page({
				pageHandle: input.receipt.integrity,
				stream: 'proof',
				cursor,
			}) as { chunkBase64: string; nextCursor: string | null };
			expect(completeCallToolResultBytes(page)).toBeLessThanOrEqual(
				PAGED_CALL_TOOL_MAX_BYTES,
			);
			chunks.push(Buffer.from(page.chunkBase64, 'base64'));
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		expect(Buffer.concat(chunks).toString('utf8')).toBe(JSON.stringify(input.receipt));
	});

	test('binds filtered coverage and every cursor dimension', () => {
		const first = new SafeChangePageCache();
		const second = new SafeChangePageCache();
		const input = bundle();
		const head = first.set(input.bundle) as { semantic: { firstCursor: string } };
		second.set(input.bundle);
		const filtered = first.page({
			pageHandle: input.receipt.integrity,
			stream: 'semantic',
			filter: { file: 'source.ts', role: 'read' },
		}) as { coverage: string; filter: object; counts: { parent: number; filtered: number } };
		expect(filtered).toMatchObject({
			state: 'complete',
			coverage: 'filtered',
			filter: { file: 'source.ts', role: 'read' },
		});
		expect(filtered.counts.filtered).toBeLessThanOrEqual(filtered.counts.parent);
		const cursor = head.semantic.firstCursor;
		expect(
			first.page({ pageHandle: input.receipt.integrity, stream: 'semantic', cursor }),
		).toEqual(first.page({ pageHandle: input.receipt.integrity, stream: 'semantic', cursor }));
		expectRefusal(
			first.page({ pageHandle: input.receipt.integrity, stream: 'proof', cursor }),
			'invalid-page-cursor',
		);
		expectRefusal(
			first.page({
				pageHandle: input.receipt.integrity,
				stream: 'semantic',
				cursor,
				filter: { file: 'source.ts' },
			}),
			'invalid-page-cursor',
		);
		expectRefusal(
			first.page({
				pageHandle: input.receipt.integrity,
				stream: 'semantic',
				cursor: `${cursor.slice(0, -1)}x`,
			}),
			'invalid-page-cursor',
		);
		expectRefusal(
			second.page({ pageHandle: input.receipt.integrity, stream: 'semantic', cursor }),
			'invalid-page-cursor',
		);
	});

	test('rejects legacy re-signing, malformed cursors, and every strict-shape mutation', () => {
		const cache = new SafeChangePageCache();
		const input = bundle();
		const head = cache.set(input.bundle) as { semantic: { firstCursor: string } };
		const genuine = head.semantic.firstCursor;
		const payload = decodedCursor(genuine);
		const reversed = Object.fromEntries(Object.entries(payload).reverse());
		const mutations = [
			{ ...payload, cache: '0'.repeat(32) },
			{ ...payload, handle: '0'.repeat(64) },
			{ ...payload, stream: 'proof' },
			{ ...payload, filter: '0'.repeat(64) },
			{ ...payload, index: 1 },
			{ ...payload, digest: '0'.repeat(64) },
			reversed,
			{ ...payload, extra: true },
			Object.fromEntries(Object.entries(payload).slice(1)),
			{ ...payload, index: -1 },
			{ ...payload, index: 0.5 },
			{ ...payload, index: Number.MAX_SAFE_INTEGER + 1 },
		];
		for (const mutation of mutations)
			expectRefusal(
				cache.page({
					pageHandle: input.receipt.integrity,
					stream: 'semantic',
					cursor: legacyCursor(mutation),
				}),
				'invalid-page-cursor',
			);
		const [body, signature] = genuine.split('.') as [string, string];
		for (const malformed of [
			`${body}.${'0'.repeat(64)}`,
			`${body}.${signature.slice(1)}`,
			`${body}.${signature}0`,
			`%%%.${signature}`,
			`${Buffer.from('{').toString('base64url')}.${'0'.repeat(64)}`,
			`${genuine}.extra`,
			'x'.repeat(2_049),
		])
			expectRefusal(
				cache.page({
					pageHandle: input.receipt.integrity,
					stream: 'semantic',
					cursor: malformed,
				}),
				'invalid-page-cursor',
			);
	});

	test('uses deterministic LRU eviction and refuses oversize bundles without fallback', () => {
		const input = bundle();
		const staleCache = new SafeChangePageCache();
		const expanded = {
			...input.bundle,
			facts: Array.from({ length: 100 }, (_, index) => ({
				...input.bundle.facts[0]!,
				id: createHash('sha256').update(String(index)).digest('hex'),
			})),
		};
		const expandedHead = staleCache.set(expanded) as { semantic: { firstCursor: string } };
		const expandedFirst = staleCache.page({
			pageHandle: input.receipt.integrity,
			stream: 'semantic',
			cursor: expandedHead.semantic.firstCursor,
		}) as { nextCursor: string };
		expect(expandedFirst.nextCursor).toBeTypeOf('string');
		staleCache.set(input.bundle);
		expectRefusal(
			staleCache.page({
				pageHandle: input.receipt.integrity,
				stream: 'semantic',
				cursor: expandedFirst.nextCursor,
			}),
			'invalid-page-cursor',
		);
		const cache = new SafeChangePageCache(1);
		cache.set(input.bundle);
		const other = { ...input.bundle, proofHandle: 'a'.repeat(64) };
		cache.set(other);
		expectRefusal(
			cache.page({ pageHandle: input.receipt.integrity, stream: 'semantic' }),
			'unknown-page-handle',
		);
		const tiny = new SafeChangePageCache(8, 32 * 1024 * 1024, 10);
		expectRefusal(tiny.set(input.bundle), 'paged-proof-too-large');
		const hugeFact = {
			...input.bundle,
			facts: [
				{
					...input.bundle.facts[0]!,
					label: 'x'.repeat(9_000),
				},
			],
		};
		expectRefusal(new SafeChangePageCache().set(hugeFact), 'paged-transport-limit');
	});

	test('reconstructs all 18 frozen proofs and both large Execa semantic streams exactly', () => {
		const receiptDirectory = resolve('packages/evaluation/fixtures/oracle-part-3-v6/receipts');
		const files = readdirSync(receiptDirectory)
			.filter((file) => file.endsWith('.full.json.gz'))
			.sort();
		expect(files).toHaveLength(18);
		const expectedLarge = new Map([
			['execa-entry-execa-core-async.full.json.gz', { classified: 5_957, unresolved: 538 }],
			['execa-entry-create-execa.full.json.gz', { classified: 6_797, unresolved: 588 }],
		]);
		const retainedLarge = new SafeChangePageCache();
		for (const file of files) {
			const source = gunzipSync(readFileSync(resolve(receiptDirectory, file)));
			const receipt = JSON.parse(source.toString('utf8')) as Receipt<SafeChangeImpactResult>;
			const proof = Buffer.from(JSON.stringify(receipt));
			const bundle = makeSafeChangePagedBundle(receipt);
			const cache = new SafeChangePageCache();
			const head = cache.set(bundle) as {
				state: string;
				counts: { classified: number; unresolved: number };
				semantic: { firstCursor: string };
				proof: { firstCursor: string; sha256: string; bytes: number };
			};
			if (head.state === 'refused')
				throw new Error(`frozen paged head refused for ${file}: ${JSON.stringify(head)}`);
			expect(head.proof.bytes).toBe(proof.byteLength);
			expect(head.proof.sha256).toBe(createHash('sha256').update(proof).digest('hex'));
			const chunks: Buffer[] = [];
			let maximumProofPageBytes = 0;
			let cursor: string | undefined = head.proof.firstCursor;
			do {
				const page = cache.page({
					pageHandle: receipt.integrity,
					stream: 'proof',
					cursor,
				}) as { chunkBase64: string; nextCursor: string | null };
				maximumProofPageBytes = Math.max(
					maximumProofPageBytes,
					completeCallToolResultBytes(page),
				);
				chunks.push(Buffer.from(page.chunkBase64, 'base64'));
				cursor = page.nextCursor ?? undefined;
			} while (cursor !== undefined);
			expect(maximumProofPageBytes).toBeLessThanOrEqual(PAGED_CALL_TOOL_MAX_BYTES);
			const reconstructed = Buffer.concat(chunks);
			expect(reconstructed.byteLength).toBe(proof.byteLength);
			expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(
				createHash('sha256').update(proof).digest('hex'),
			);

			const expected = expectedLarge.get(file);
			if (expected !== undefined) {
				expect(head.counts).toMatchObject(expected);
				const facts: unknown[] = [];
				let maximumSemanticPageBytes = 0;
				cursor = head.semantic.firstCursor;
				do {
					const page = cache.page({
						pageHandle: receipt.integrity,
						stream: 'semantic',
						cursor,
					}) as { facts: unknown[]; nextCursor: string | null };
					if (!Array.isArray(page.facts))
						throw new Error(`large semantic page refused: ${JSON.stringify(page)}`);
					maximumSemanticPageBytes = Math.max(
						maximumSemanticPageBytes,
						completeCallToolResultBytes(page),
					);
					facts.push(...page.facts);
					cursor = page.nextCursor ?? undefined;
				} while (cursor !== undefined);
				expect(maximumSemanticPageBytes).toBeLessThanOrEqual(PAGED_CALL_TOOL_MAX_BYTES);
				expect(facts).toEqual(bundle.facts);
				expect(retainedLarge.set(bundle)).not.toMatchObject({ state: 'refused' });
			}
		}
		expect(retainedLarge.size).toBe(2);
		expect(retainedLarge.compressedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
	}, 120_000);
});
