import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import { createGuesslessMcpServer } from '../src/index.ts';

const sources = Array.from({ length: 24 }, (_, index) => ({
	path: `src/module-${String(index).padStart(2, '0')}.ts`,
	source: `export const value${index} = ${index};`,
}));

function requestBytes(name: string, arguments_: Record<string, unknown>): number {
	return Buffer.byteLength(JSON.stringify({ name, arguments: arguments_ }), 'utf8');
}

const explicitCalls = sources.length + 1;
const batchCalls = 1;
const rootCalls = 1;
const explicitBytes =
	sources.reduce(
		(sum, source) =>
			sum + requestBytes('guessless_add_file', { path: source.path, source: source.source }),
		0,
	) + requestBytes('guessless_link', {});
const batchBytes = requestBytes('guessless_prepare_snapshot', { sources });
const benchmarkRoot = await realpath(
	await mkdtemp(join(tmpdir(), 'guessless-preparation-benchmark-')),
);
for (const source of sources) {
	const path = join(benchmarkRoot, source.path);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, source.source);
}
const rootUri = pathToFileURL(benchmarkRoot).href;
const rootBytes = requestBytes('guessless_prepare_snapshot', { rootUri });
const byteReduction = 1 - batchBytes / explicitBytes;
const byteTarget = byteReduction >= 0.8 ? 'PASS' : 'MISS';
const rootByteReduction = 1 - rootBytes / explicitBytes;
const rootByteTarget = rootByteReduction >= 0.8 ? 'PASS' : 'MISS';
if (rootByteTarget !== 'PASS')
	throw new Error('root-reference request bytes missed the frozen 80% target');

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function responseBytes(result: CallToolResult): number {
	return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

async function harness(configuredRoot?: string): Promise<{
	client: Client;
	server: ReturnType<typeof createGuesslessMcpServer>;
}> {
	const server = createGuesslessMcpServer(undefined, configuredRoot);
	const client = new Client({ name: 'guessless-preparation-benchmark', version: '0.0.1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

async function measurePreparation(): Promise<{
	readonly explicitMedianElapsedMs: number;
	readonly batchMedianElapsedMs: number;
	readonly rootMedianElapsedMs: number;
	readonly explicitResponseBytes: number;
	readonly batchResponseBytes: number;
	readonly rootResponseBytes: number;
}> {
	const explicit = await harness();
	const batch = await harness();
	const root = await harness(benchmarkRoot);
	const explicitElapsedMs: number[] = [];
	const batchElapsedMs: number[] = [];
	const rootElapsedMs: number[] = [];
	let explicitResponseBytes = 0;
	let batchResponseBytes = 0;
	let rootResponseBytes = 0;
	try {
		for (let iteration = 0; iteration < 20; iteration += 1) {
			let started = performance.now();
			let explicitIterationResponseBytes = 0;
			for (const source of sources) {
				const result = (await explicit.client.callTool({
					name: 'guessless_add_file',
					arguments: source,
				})) as CallToolResult;
				if (result.isError === true)
					throw new Error('explicit preparation benchmark failed');
				explicitIterationResponseBytes += responseBytes(result);
			}
			const linked = (await explicit.client.callTool({
				name: 'guessless_link',
				arguments: {},
			})) as CallToolResult;
			if (linked.isError === true) throw new Error('explicit link benchmark failed');
			explicitIterationResponseBytes += responseBytes(linked);
			explicitElapsedMs.push(performance.now() - started);
			explicitResponseBytes = explicitIterationResponseBytes;

			started = performance.now();
			const prepared = (await batch.client.callTool({
				name: 'guessless_prepare_snapshot',
				arguments: { sources },
			})) as CallToolResult;
			if (prepared.isError === true) throw new Error('batch preparation benchmark failed');
			batchElapsedMs.push(performance.now() - started);
			batchResponseBytes = responseBytes(prepared);

			started = performance.now();
			const rooted = (await root.client.callTool({
				name: 'guessless_prepare_snapshot',
				arguments: { rootUri },
			})) as CallToolResult;
			if (rooted.isError === true || rooted.structuredContent?.state !== 'complete')
				throw new Error('root-reference preparation benchmark failed');
			rootElapsedMs.push(performance.now() - started);
			rootResponseBytes = responseBytes(rooted);
		}
		return {
			explicitMedianElapsedMs: median(explicitElapsedMs),
			batchMedianElapsedMs: median(batchElapsedMs),
			rootMedianElapsedMs: median(rootElapsedMs),
			explicitResponseBytes,
			batchResponseBytes,
			rootResponseBytes,
		};
	} finally {
		await explicit.client.close();
		await explicit.server.close();
		await batch.client.close();
		await batch.server.close();
		await root.client.close();
		await root.server.close();
	}
}

const measurement = await measurePreparation();

describe('prepared snapshot setup', () => {
	let explicit: Awaited<ReturnType<typeof harness>>;
	let batch: Awaited<ReturnType<typeof harness>>;
	let root: Awaited<ReturnType<typeof harness>>;

	beforeAll(async () => {
		explicit = await harness();
		batch = await harness();
		root = await harness(benchmarkRoot);
	});

	afterAll(async () => {
		await explicit.client.close();
		await explicit.server.close();
		await batch.client.close();
		await batch.server.close();
		await root.client.close();
		await root.server.close();
		await rm(benchmarkRoot, { recursive: true, force: true });
	});

	bench(`explicit add/link | calls=${explicitCalls} requestPayloadBytes=${explicitBytes} completeResponsePayloadBytes=${measurement.explicitResponseBytes} combinedPayloadBytes=${explicitBytes + measurement.explicitResponseBytes} measuredMedianMs=${measurement.explicitMedianElapsedMs.toFixed(3)}`, async () => {
		for (const source of sources)
			await explicit.client.callTool({
				name: 'guessless_add_file',
				arguments: source,
			});
		await explicit.client.callTool({ name: 'guessless_link', arguments: {} });
	});

	bench(`batch prepare | calls=${batchCalls} requestPayloadBytes=${batchBytes} completeResponsePayloadBytes=${measurement.batchResponseBytes} combinedPayloadBytes=${batchBytes + measurement.batchResponseBytes} measuredMedianMs=${measurement.batchMedianElapsedMs.toFixed(3)} requestByteReduction=${(
		byteReduction * 100
	).toFixed(2)}% target80=${byteTarget}`, async () => {
		await batch.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { sources },
		});
	});

	bench(`root reference | calls=${rootCalls} requestPayloadBytes=${rootBytes} completeResponsePayloadBytes=${measurement.rootResponseBytes} combinedPayloadBytes=${rootBytes + measurement.rootResponseBytes} measuredMedianMs=${measurement.rootMedianElapsedMs.toFixed(3)} requestByteReduction=${(
		rootByteReduction * 100
	).toFixed(2)}% target80=${rootByteTarget}`, async () => {
		await root.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri },
		});
	});
});
