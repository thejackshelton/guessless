import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import { type Receipt, type SafeChangeImpactResult } from '../../engine/src/index.ts';
import { createGuesslessMcpServer } from '../src/index.ts';
import {
	SafeChangePageCache,
	completeCallToolResultBytes,
	makeSafeChangePagedBundle,
} from '../src/page-cache.ts';
import { SafeChangeProofCache } from '../src/proof-cache.ts';

const intents = [
	['rename', 'src/core.ts', 'mutableTarget'],
	['delete', 'src/core.ts', 'mutableTarget'],
	['entry-point', 'src/entry.ts', 'entry'],
] as const;

function frozenCorpus(): Map<string, string> {
	const files = new Map<string, string>([
		[
			'src/core.ts',
			[
				'export let mutableTarget = 1;',
				'mutableTarget;',
				'mutableTarget++;',
				'export function leaf(): number { return mutableTarget; }',
			].join('\n'),
		],
		[
			'src/consumer.ts',
			"import { mutableTarget as observed } from './core';\nexport const consumer = observed;",
		],
		[
			'src/entry.ts',
			"import { leaf as dependency } from './core';\nexport function entry(): number { return dependency(); }",
		],
	]);
	for (let index = 0; index < 21; index += 1)
		files.set(
			`src/filler-${String(index).padStart(2, '0')}.${index % 2 === 0 ? 'ts' : 'js'}`,
			`export const filler${index} = ${index};`,
		);
	return files;
}

async function corpusRoot(prefix: string): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	for (const [path, source] of frozenCorpus()) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	return root;
}

function payloadBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

async function harness(root: string, proofCache?: SafeChangeProofCache) {
	const server = createGuesslessMcpServer(undefined, root, proofCache);
	const client = new Client({ name: 'guessless-warm-benchmark', version: '0.0.1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

function impactRequest(snapshot: string, intent: (typeof intents)[number]) {
	return {
		name: 'guessless_safe_change_impact',
		arguments: {
			snapshot,
			intent: intent[0],
			target: { file: intent[1], name: intent[2], space: 'value' },
		},
	};
}

function summaryRequest(snapshot: string, intent: (typeof intents)[number]) {
	return {
		...impactRequest(snapshot, intent),
		arguments: { ...impactRequest(snapshot, intent).arguments, view: 'summary' },
	};
}

const immutableRoot = await corpusRoot('guessless-warm-benchmark-');
const changedRoot = await corpusRoot('guessless-changed-benchmark-');
const immutableRootUri = pathToFileURL(immutableRoot).href;
const changedRootUri = pathToFileURL(changedRoot).href;

async function measureWorkflows() {
	const immutable = await harness(immutableRoot);
	const changed = await harness(changedRoot);
	const oversize = await harness(immutableRoot, new SafeChangeProofCache(8, 1));
	const coldElapsed: number[] = [];
	const fullWarmElapsed: number[] = [];
	const summaryWarmElapsed: number[] = [];
	const changedElapsed: number[] = [];
	let coldRequestBytes = 0;
	let coldResponseBytes = 0;
	let fullWarmRequestBytes = 0;
	let fullWarmResponseBytes = 0;
	let summaryWarmRequestBytes = 0;
	let summaryWarmResponseBytes = 0;
	let expansionRequestBytes = 0;
	let expansionResponseBytes = 0;
	let oversizeRequestBytes = 0;
	let oversizeResponseBytes = 0;
	let changedRequestBytes = 0;
	let changedResponseBytes = 0;
	try {
		const oversizePrepared = (await oversize.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri: immutableRootUri },
		})) as CallToolResult;
		const oversizeSnapshot = oversizePrepared.structuredContent?.snapshot as string;
		await changed.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri: changedRootUri },
		});
		for (let iteration = 0; iteration < 20; iteration += 1) {
			let coldIterationRequestBytes = 0;
			let coldIterationResponseBytes = 0;
			let fullWarmIterationRequestBytes = 0;
			let fullWarmIterationResponseBytes = 0;
			let summaryWarmIterationRequestBytes = 0;
			let summaryWarmIterationResponseBytes = 0;
			let expansionIterationRequestBytes = 0;
			let expansionIterationResponseBytes = 0;
			let coldIterationElapsed = 0;
			let fullWarmIterationElapsed = 0;
			let summaryWarmIterationElapsed = 0;
			for (const intent of intents) {
				const prepareRequest = {
					name: 'guessless_prepare_snapshot',
					arguments: { rootUri: immutableRootUri },
				};
				let started = performance.now();
				const prepared = (await immutable.client.callTool(
					prepareRequest,
				)) as CallToolResult;
				const snapshot = prepared.structuredContent?.snapshot as string;
				const request = impactRequest(snapshot, intent);
				const cold = (await immutable.client.callTool(request)) as CallToolResult;
				coldIterationElapsed += performance.now() - started;
				coldIterationRequestBytes += payloadBytes(prepareRequest) + payloadBytes(request);
				coldIterationResponseBytes += payloadBytes(prepared) + payloadBytes(cold);

				started = performance.now();
				const fullWarm = (await immutable.client.callTool(request)) as CallToolResult;
				fullWarmIterationElapsed += performance.now() - started;
				fullWarmIterationRequestBytes += payloadBytes(request);
				fullWarmIterationResponseBytes += payloadBytes(fullWarm);
				if (JSON.stringify(fullWarm) !== JSON.stringify(cold))
					throw new Error('warm safe-change receipt differs from cold receipt');

				const compactRequest = summaryRequest(snapshot, intent);
				started = performance.now();
				const summary = (await immutable.client.callTool(compactRequest)) as CallToolResult;
				summaryWarmIterationElapsed += performance.now() - started;
				summaryWarmIterationRequestBytes += payloadBytes(compactRequest);
				summaryWarmIterationResponseBytes += payloadBytes(summary);
				const expansionRequest = {
					name: 'guessless_expand_safe_change_proof',
					arguments: { proofHandle: summary.structuredContent?.proofHandle },
				};
				const expanded = (await immutable.client.callTool(
					expansionRequest,
				)) as CallToolResult;
				expansionIterationRequestBytes += payloadBytes(expansionRequest);
				expansionIterationResponseBytes += payloadBytes(expanded);
				if (JSON.stringify(expanded) !== JSON.stringify(fullWarm))
					throw new Error(
						'expanded safe-change proof differs from the exact full receipt',
					);
			}
			coldElapsed.push(coldIterationElapsed);
			fullWarmElapsed.push(fullWarmIterationElapsed);
			summaryWarmElapsed.push(summaryWarmIterationElapsed);
			coldRequestBytes = coldIterationRequestBytes;
			coldResponseBytes = coldIterationResponseBytes;
			fullWarmRequestBytes = fullWarmIterationRequestBytes;
			fullWarmResponseBytes = fullWarmIterationResponseBytes;
			summaryWarmRequestBytes = summaryWarmIterationRequestBytes;
			summaryWarmResponseBytes = summaryWarmIterationResponseBytes;
			expansionRequestBytes = expansionIterationRequestBytes;
			expansionResponseBytes = expansionIterationResponseBytes;
			oversizeRequestBytes = 0;
			oversizeResponseBytes = 0;
			for (const intent of intents) {
				const request = summaryRequest(oversizeSnapshot, intent);
				const fallback = (await oversize.client.callTool(request)) as CallToolResult;
				if (fallback.structuredContent?.schema !== 'guessless.receipt/v1')
					throw new Error('oversized proof did not return the exact full receipt inline');
				oversizeRequestBytes += payloadBytes(request);
				oversizeResponseBytes += payloadBytes(fallback);
			}

			const changedSource = frozenCorpus()
				.get('src/core.ts')!
				.replace('mutableTarget = 1', `mutableTarget = ${iteration % 2 === 0 ? 2 : 3}`);
			await writeFile(join(changedRoot, 'src/core.ts'), changedSource);
			const changedRequest = {
				name: 'guessless_prepare_snapshot',
				arguments: { rootUri: changedRootUri },
			};
			const changedStarted = performance.now();
			const changedResult = (await changed.client.callTool(changedRequest)) as CallToolResult;
			changedElapsed.push(performance.now() - changedStarted);
			changedRequestBytes = payloadBytes(changedRequest);
			changedResponseBytes = payloadBytes(changedResult);
		}
	} finally {
		await immutable.client.close();
		await immutable.server.close();
		await changed.client.close();
		await changed.server.close();
		await oversize.client.close();
		await oversize.server.close();
	}
	const coldCombinedBytes = coldRequestBytes + coldResponseBytes;
	const fullWarmCombinedBytes = fullWarmRequestBytes + fullWarmResponseBytes;
	const summaryWarmCombinedBytes = summaryWarmRequestBytes + summaryWarmResponseBytes;
	const expansionCombinedBytes = expansionRequestBytes + expansionResponseBytes;
	const alwaysExpandedCombinedBytes = summaryWarmCombinedBytes + expansionCombinedBytes;
	const alwaysExpandedRequestBytes = summaryWarmRequestBytes + expansionRequestBytes;
	const alwaysExpandedResponseBytes = summaryWarmResponseBytes + expansionResponseBytes;
	const oversizeCombinedBytes = oversizeRequestBytes + oversizeResponseBytes;
	const summaryResponseReduction = 1 - summaryWarmResponseBytes / fullWarmResponseBytes;
	const summaryPayloadReduction = 1 - summaryWarmCombinedBytes / coldCombinedBytes;
	const coldMedianMs = median(coldElapsed);
	const fullWarmMedianMs = median(fullWarmElapsed);
	const summaryWarmMedianMs = median(summaryWarmElapsed);
	const latencyReduction = 1 - summaryWarmMedianMs / coldMedianMs;
	const summaryLatencyRegression = summaryWarmMedianMs / fullWarmMedianMs - 1;
	const measured = {
		coldRequestBytes,
		coldResponseBytes,
		coldCombinedBytes,
		fullWarmRequestBytes,
		fullWarmResponseBytes,
		fullWarmCombinedBytes,
		summaryWarmRequestBytes,
		summaryWarmResponseBytes,
		summaryWarmCombinedBytes,
		expansionRequestBytes,
		expansionResponseBytes,
		expansionCombinedBytes,
		alwaysExpandedCombinedBytes,
		alwaysExpandedRequestBytes,
		alwaysExpandedResponseBytes,
		oversizeRequestBytes,
		oversizeResponseBytes,
		oversizeCombinedBytes,
		summaryResponseReduction,
		summaryPayloadReduction,
		coldMedianMs,
		fullWarmMedianMs,
		summaryWarmMedianMs,
		latencyReduction,
		summaryLatencyRegression,
		changedRequestBytes,
		changedResponseBytes,
		changedCombinedBytes: changedRequestBytes + changedResponseBytes,
		changedMedianMs: median(changedElapsed),
	};
	const failures = [
		summaryResponseReduction < 0.5
			? `response ${(summaryResponseReduction * 100).toFixed(2)}% < 50%`
			: null,
		summaryPayloadReduction < 0.7
			? `warm combined ${(summaryPayloadReduction * 100).toFixed(2)}% < 70%`
			: null,
		latencyReduction < 0.3
			? `cold latency ${(latencyReduction * 100).toFixed(2)}% < 30%`
			: null,
		summaryLatencyRegression > 0.05
			? `summary/full latency regression ${(summaryLatencyRegression * 100).toFixed(2)}% > 5%`
			: null,
	].filter((failure): failure is string => failure !== null);
	if (failures.length > 0)
		throw new Error(
			`frozen metrics ${JSON.stringify(measured)}; gate failures: ${failures.join('; ')}`,
		);
	return measured;
}

const measurement = await measureWorkflows();

describe('immutable warm-snapshot workflow', () => {
	let immutable: Awaited<ReturnType<typeof harness>>;
	let changed: Awaited<ReturnType<typeof harness>>;
	let oversize: Awaited<ReturnType<typeof harness>>;
	let warmSnapshot: string;
	let oversizeSnapshot: string;
	let warmProofHandles: string[];
	let changedIteration = 0;

	beforeAll(async () => {
		immutable = await harness(immutableRoot);
		changed = await harness(changedRoot);
		oversize = await harness(immutableRoot, new SafeChangeProofCache(8, 1));
		const prepared = (await immutable.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri: immutableRootUri },
		})) as CallToolResult;
		warmSnapshot = prepared.structuredContent?.snapshot as string;
		const oversizePrepared = (await oversize.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri: immutableRootUri },
		})) as CallToolResult;
		oversizeSnapshot = oversizePrepared.structuredContent?.snapshot as string;
		warmProofHandles = [];
		for (const intent of intents) {
			const summary = (await immutable.client.callTool(
				summaryRequest(warmSnapshot, intent),
			)) as CallToolResult;
			warmProofHandles.push(summary.structuredContent?.proofHandle as string);
		}
	});

	afterAll(async () => {
		await immutable.client.close();
		await immutable.server.close();
		await changed.client.close();
		await changed.server.close();
		await oversize.client.close();
		await oversize.server.close();
		await rm(immutableRoot, { recursive: true, force: true });
		await rm(changedRoot, { recursive: true, force: true });
	});

	bench(`cold all intents | totalCalls=6 perIntentCalls=2 requestPayloadBytes=${measurement.coldRequestBytes} completeResponsePayloadBytes=${measurement.coldResponseBytes} combinedPayloadBytes=${measurement.coldCombinedBytes} measuredMedianMs=${measurement.coldMedianMs.toFixed(3)}`, async () => {
		for (const intent of intents) {
			const prepared = (await immutable.client.callTool({
				name: 'guessless_prepare_snapshot',
				arguments: { rootUri: immutableRootUri },
			})) as CallToolResult;
			await immutable.client.callTool(
				impactRequest(prepared.structuredContent?.snapshot as string, intent),
			);
		}
	});

	bench(`full warm all intents | totalCalls=3 perIntentCalls=1 requestPayloadBytes=${measurement.fullWarmRequestBytes} completeResponsePayloadBytes=${measurement.fullWarmResponseBytes} combinedPayloadBytes=${measurement.fullWarmCombinedBytes} measuredMedianMs=${measurement.fullWarmMedianMs.toFixed(3)}`, async () => {
		for (const intent of intents)
			await immutable.client.callTool(impactRequest(warmSnapshot, intent));
	});

	bench(`summary warm all intents | totalCalls=3 perIntentCalls=1 requestPayloadBytes=${measurement.summaryWarmRequestBytes} completeResponsePayloadBytes=${measurement.summaryWarmResponseBytes} combinedPayloadBytes=${measurement.summaryWarmCombinedBytes} measuredMedianMs=${measurement.summaryWarmMedianMs.toFixed(3)} responseReduction=${(measurement.summaryResponseReduction * 100).toFixed(2)}% target50=PASS coldCombinedReduction=${(measurement.summaryPayloadReduction * 100).toFixed(2)}% target70=PASS coldLatencyReduction=${(measurement.latencyReduction * 100).toFixed(2)}% target30=PASS fullLatencyRegression=${(measurement.summaryLatencyRegression * 100).toFixed(2)}% max5=PASS`, async () => {
		for (const intent of intents)
			await immutable.client.callTool(summaryRequest(warmSnapshot, intent));
	});

	bench(`optional expansion all intents | totalCalls=3 requestPayloadBytes=${measurement.expansionRequestBytes} completeResponsePayloadBytes=${measurement.expansionResponseBytes} combinedPayloadBytes=${measurement.expansionCombinedBytes}`, async () => {
		for (const proofHandle of warmProofHandles) {
			await immutable.client.callTool({
				name: 'guessless_expand_safe_change_proof',
				arguments: { proofHandle },
			});
		}
	});

	bench(`always-expanded disclosure | totalCalls=6 requestPayloadBytes=${measurement.alwaysExpandedRequestBytes} completeResponsePayloadBytes=${measurement.alwaysExpandedResponseBytes} combinedPayloadBytes=${measurement.alwaysExpandedCombinedBytes} savingsClaim=NONE`, async () => {
		for (const intent of intents) {
			const summary = (await immutable.client.callTool(
				summaryRequest(warmSnapshot, intent),
			)) as CallToolResult;
			await immutable.client.callTool({
				name: 'guessless_expand_safe_change_proof',
				arguments: { proofHandle: summary.structuredContent?.proofHandle },
			});
		}
	});

	bench(`oversized full-inline fallback (1-byte test-only cache budget) | totalCalls=3 requestPayloadBytes=${measurement.oversizeRequestBytes} completeResponsePayloadBytes=${measurement.oversizeResponseBytes} combinedPayloadBytes=${measurement.oversizeCombinedBytes} savingsClaim=NONE`, async () => {
		for (const intent of intents)
			await oversize.client.callTool(summaryRequest(oversizeSnapshot, intent));
	});

	bench(`changed root full reprepare (no reuse) | calls=1 requestPayloadBytes=${measurement.changedRequestBytes} completeResponsePayloadBytes=${measurement.changedResponseBytes} combinedPayloadBytes=${measurement.changedCombinedBytes} measuredMedianMs=${measurement.changedMedianMs.toFixed(3)}`, async () => {
		const source = frozenCorpus()
			.get('src/core.ts')!
			.replace('mutableTarget = 1', `mutableTarget = ${changedIteration % 2 === 0 ? 4 : 5}`);
		changedIteration += 1;
		await writeFile(join(changedRoot, 'src/core.ts'), source);
		await changed.client.callTool({
			name: 'guessless_prepare_snapshot',
			arguments: { rootUri: changedRootUri },
		});
	});
});

const pagedBenchmarks = [
	['small', 'ufo-rename-encode-query-item'],
	['execa-core', 'execa-entry-execa-core-async'],
	['execa-create', 'execa-entry-create-execa'],
] as const;

describe('paged safe-change transport', () => {
	for (const [label, id] of pagedBenchmarks) {
		const receipt = JSON.parse(
			gunzipSync(
				readFileSync(
					join(
						process.cwd(),
						`packages/evaluation/fixtures/oracle-part-3-v6/receipts/${id}.full.json.gz`,
					),
				),
			).toString('utf8'),
		) as Receipt<SafeChangeImpactResult>;
		const bundle = makeSafeChangePagedBundle(receipt);
		const measurementCache = new SafeChangePageCache();
		const head = measurementCache.set(bundle) as {
			semantic: { firstCursor: string };
			proof: { firstCursor: string };
		};
		const semantic = measurementCache.page({
			pageHandle: receipt.integrity,
			stream: 'semantic',
			cursor: head.semantic.firstCursor,
		});
		const filtered = measurementCache.page({
			pageHandle: receipt.integrity,
			stream: 'semantic',
			filter: { file: bundle.facts[0]?.file },
		});
		const proof = measurementCache.page({
			pageHandle: receipt.integrity,
			stream: 'proof',
			cursor: head.proof.firstCursor,
		});
		const options = { iterations: 1, time: 0 };
		bench(
			`paged ${label} head | envelopeBytes=${completeCallToolResultBytes(head)} proofBytes=${Buffer.byteLength(bundle.proof)} compressedBytes=${gzipSync(Buffer.from(bundle.proof)).byteLength}`,
			() => {
				new SafeChangePageCache().set(bundle);
			},
			options,
		);
		bench(
			`paged ${label} first semantic | envelopeBytes=${completeCallToolResultBytes(semantic)}`,
			() => {
				measurementCache.page({
					pageHandle: receipt.integrity,
					stream: 'semantic',
					cursor: head.semantic.firstCursor,
				});
			},
			options,
		);
		bench(
			`paged ${label} filtered semantic | envelopeBytes=${completeCallToolResultBytes(filtered)}`,
			() => {
				measurementCache.page({
					pageHandle: receipt.integrity,
					stream: 'semantic',
					filter: { file: bundle.facts[0]?.file },
				});
			},
			options,
		);
		bench(
			`paged ${label} proof page | envelopeBytes=${completeCallToolResultBytes(proof)}`,
			() => {
				measurementCache.page({
					pageHandle: receipt.integrity,
					stream: 'proof',
					cursor: head.proof.firstCursor,
				});
			},
			options,
		);
		bench(
			`paged ${label} gzip proof`,
			() => {
				gzipSync(Buffer.from(bundle.proof));
			},
			options,
		);
	}
});
