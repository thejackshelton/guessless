import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { createGuesslessMcpServer, GuesslessEngine } from '../src/index.ts';
import { createCanonicalPathTracker, ROOT_SCAN_POLICY, scanStableRoot } from '../src/root.ts';

type Harness = {
	client: Client;
	server?: ReturnType<typeof createGuesslessMcpServer>;
	transport?: StdioClientTransport;
};

const harnesses: Harness[] = [];
const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function fixture(): Promise<{
	root: string;
	sources: Array<{ path: string; source: string }>;
}> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'guessless-root-')));
	roots.push(root);
	const sources = [
		{ path: 'leaf.ts', source: 'export function leaf(): void {}' },
		{
			path: 'src/entry.ts',
			source: [
				"import { leaf as dependency } from '../leaf';",
				'export let value = 1;',
				'value++;',
				'export function entry(): void { dependency(); }',
			].join('\n'),
		},
	];
	for (const source of sources) {
		await mkdir(dirname(join(root, source.path)), { recursive: true });
		await writeFile(join(root, source.path), source.source);
	}
	await writeFile(join(root, 'README.md'), '# outside language boundary\n');
	for (const excluded of ROOT_SCAN_POLICY.excludedDirectoryNames) {
		await mkdir(join(root, excluded), { recursive: true });
		await writeFile(join(root, excluded, 'ignored.ts'), 'export const ignored = true;');
	}
	return { root, sources };
}

async function memoryHarness(configuredRoot: string): Promise<Harness> {
	const server = createGuesslessMcpServer(new GuesslessEngine(), configuredRoot);
	const client = new Client({ name: 'guessless-root-test', version: '0.0.1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	const harness = { client, server };
	harnesses.push(harness);
	return harness;
}

async function stdioHarness(cwd: string): Promise<Harness> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
		cwd,
		stderr: 'pipe',
	});
	const client = new Client({ name: 'guessless-root-stdio-test', version: '0.0.1' });
	await client.connect(transport);
	const harness = { client, transport };
	harnesses.push(harness);
	return harness;
}

async function call(
	harness: Harness,
	name: string,
	arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
	return harness.client.callTool({ name, arguments: arguments_ }) as Promise<CallToolResult>;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.client.close().catch(() => undefined);
		await harness.server?.close().catch(() => undefined);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('root-reference preparation', () => {
	test('uses one deterministic production tracker for case and Unicode canonical collisions', () => {
		for (const [first, second] of [
			['Source.ts', 'source.ts'],
			['Kelvin.ts', 'kelvin.ts'],
			['café.ts', 'cafe\u0301.ts'],
		] as const) {
			const tracker = createCanonicalPathTracker();
			expect(tracker.add(first)).toBeNull();
			expect(tracker.add(second)).toEqual({ prior: first, path: second });
		}
	});

	test('matches explicit snapshot, byte hashes, and all three safe-change receipts exactly', async () => {
		const { root, sources } = await fixture();
		const explicit = await memoryHarness(root);
		const referenced = await memoryHarness(root);
		const explicitPreparation = await call(explicit, 'guessless_prepare_snapshot', { sources });
		const rootPreparation = await call(referenced, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		expect(rootPreparation.isError).not.toBe(true);
		expect(rootPreparation.structuredContent).toMatchObject({
			schema: 'guessless.root-prepared-snapshot/v1',
			state: 'complete',
			snapshot: explicitPreparation.structuredContent?.snapshot,
			rootUri: pathToFileURL(root).href,
			policy: ROOT_SCAN_POLICY,
			fileCount: 2,
			indexedBytes: sources.reduce(
				(total, source) => total + Buffer.byteLength(source.source),
				0,
			),
			outsideLanguageBoundary: ['README.md'],
			excludedRootPolicy: {
				directoryNames: ROOT_SCAN_POLICY.excludedDirectoryNames,
				encountered: ['.git', '.guessless', 'node_modules'],
			},
		});
		const expectedCoverage = sources
			.map((source) => ({
				path: source.path,
				sourceSha256: createHash('sha256').update(source.source).digest('hex'),
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
		expect(rootPreparation.structuredContent?.coverage).toEqual(expectedCoverage);
		expect(rootPreparation.structuredContent?.coverage).toEqual(
			explicitPreparation.structuredContent?.coverage,
		);
		expect(rootPreparation.structuredContent?.scanDigest).toMatch(/^[a-f0-9]{64}$/);

		const snapshot = rootPreparation.structuredContent?.snapshot as string;
		for (const [intent, name] of [
			['rename', 'value'],
			['delete', 'value'],
			['entry-point', 'entry'],
		] as const) {
			const arguments_ = {
				snapshot,
				intent,
				target: { file: 'src/entry.ts', name, space: 'value' },
			};
			expect(
				(await call(referenced, 'guessless_safe_change_impact', arguments_))
					.structuredContent,
			).toEqual(
				(await call(explicit, 'guessless_safe_change_impact', arguments_))
					.structuredContent,
			);
		}
	});

	test('rejects unsafe URIs, outside roots, root and descendant symlinks before reading', async () => {
		const { root } = await fixture();
		const harness = await memoryHarness(root);
		for (const rootUri of [
			'https://example.com/source',
			'file://user@localhost/tmp/source',
			`${pathToFileURL(root).href}?query=yes`,
			`${pathToFileURL(root).href}#fragment`,
			'file:///tmp/%ZZ',
		]) {
			const result = await call(harness, 'guessless_prepare_snapshot', { rootUri });
			expect(result.structuredContent).toMatchObject({
				state: 'refused',
				reason: 'invalid-root-uri',
			});
		}
		const outside = await call(harness, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(dirname(root)).href,
		});
		expect(outside.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'outside-configured-root',
		});

		const linkedRoot = `${root}-link`;
		roots.push(linkedRoot);
		await symlink(root, linkedRoot, 'dir');
		const rootLink = await call(harness, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(linkedRoot).href,
		});
		expect(rootLink.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'root-symlink',
		});

		await symlink(join(root, 'leaf.ts'), join(root, 'linked.ts'));
		const descendant = await call(harness, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		expect(descendant.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'descendant-symlink',
		});
	});

	test('refuses invalid UTF-8, collisions, special files, unreadable entries, limits, and unstable scans', async () => {
		const invalid = await realpath(await mkdtemp(join(tmpdir(), 'guessless-invalid-')));
		roots.push(invalid);
		await writeFile(join(invalid, 'invalid.ts'), Uint8Array.from([0xff, 0xfe]));
		expect(await scanStableRoot(pathToFileURL(invalid).href, invalid)).toMatchObject({
			state: 'refused',
			reason: 'invalid-utf8',
		});

		const special = await realpath(await mkdtemp(join(tmpdir(), 'guessless-special-')));
		roots.push(special);
		await execFileAsync('/usr/bin/mkfifo', [join(special, 'pipe')]);
		expect(await scanStableRoot(pathToFileURL(special).href, special)).toMatchObject({
			state: 'refused',
			reason: 'special-file',
		});

		const unreadable = await realpath(await mkdtemp(join(tmpdir(), 'guessless-unreadable-')));
		roots.push(unreadable);
		const unreadableFile = join(unreadable, 'secret.ts');
		await writeFile(unreadableFile, 'export const secret = 1;');
		await chmod(unreadableFile, 0);
		try {
			expect(await scanStableRoot(pathToFileURL(unreadable).href, unreadable)).toMatchObject({
				state: 'refused',
				reason: 'unreadable-entry',
			});
		} finally {
			await chmod(unreadableFile, 0o600);
		}

		const limited = await realpath(await mkdtemp(join(tmpdir(), 'guessless-limited-')));
		roots.push(limited);
		await Promise.all(
			Array.from({ length: ROOT_SCAN_POLICY.maxFiles + 1 }, (_, index) =>
				writeFile(join(limited, `${index}.ts`), `export const value${index} = ${index};`),
			),
		);
		expect(await scanStableRoot(pathToFileURL(limited).href, limited)).toMatchObject({
			state: 'refused',
			reason: 'resource-limit',
		});

		const unstable = await realpath(await mkdtemp(join(tmpdir(), 'guessless-unstable-')));
		roots.push(unstable);
		await writeFile(join(unstable, 'source.ts'), 'export const before = 1;');
		expect(
			await scanStableRoot(pathToFileURL(unstable).href, unstable, async () => {
				await writeFile(join(unstable, 'source.ts'), 'export const after = 2;');
			}),
		).toMatchObject({ state: 'refused', reason: 'unstable-scan' });
	});

	test('actual stdio stays within call budgets, reparses changes, refuses stale handles, and preserves committed state after refusal', async () => {
		const { root, sources } = await fixture();
		const rootUri = pathToFileURL(root).href;
		let lifecycleHarness: Harness | undefined;
		let lifecycleSnapshot = '';
		for (const [intent, name] of [
			['rename', 'value'],
			['delete', 'value'],
			['entry-point', 'entry'],
		] as const) {
			const harness = await stdioHarness(root);
			const rootRequest = {
				name: 'guessless_prepare_snapshot',
				arguments: { rootUri },
			};
			expect(Object.keys(rootRequest.arguments)).toEqual(['rootUri']);
			expect(rootRequest.arguments).not.toHaveProperty('sources');
			for (const source of sources)
				expect(JSON.stringify(rootRequest)).not.toContain(source.source);
			const coldCalls: string[] = [];
			const prepared = (await harness.client.callTool(rootRequest)) as CallToolResult;
			coldCalls.push(rootRequest.name);
			const snapshot = prepared.structuredContent?.snapshot as string;
			const result = await call(harness, 'guessless_safe_change_impact', {
				snapshot,
				intent,
				target: { file: 'src/entry.ts', name, space: 'value' },
			});
			coldCalls.push('guessless_safe_change_impact');
			expect(coldCalls).toEqual([
				'guessless_prepare_snapshot',
				'guessless_safe_change_impact',
			]);
			expect(result.structuredContent).toMatchObject({ state: 'complete', snapshot });
			if (intent === 'rename') {
				lifecycleHarness = harness;
				lifecycleSnapshot = snapshot;
			}
		}
		if (lifecycleHarness === undefined)
			throw new Error('rename lifecycle harness was not created');

		let warmCalls = 0;
		const unchangedWarm = await call(lifecycleHarness, 'guessless_safe_change_impact', {
			snapshot: lifecycleSnapshot,
			intent: 'rename',
			target: { file: 'src/entry.ts', name: 'value', space: 'value' },
		});
		warmCalls += 1;
		expect(warmCalls).toBe(1);
		expect(unchangedWarm.structuredContent).toMatchObject({
			state: 'complete',
			snapshot: lifecycleSnapshot,
		});

		await writeFile(join(root, 'leaf.ts'), 'export function leaf(): number { return 1; }');
		const changed = await call(lifecycleHarness, 'guessless_prepare_snapshot', {
			rootUri,
		});
		expect(changed.structuredContent?.snapshot).not.toBe(lifecycleSnapshot);
		const stale = await call(lifecycleHarness, 'guessless_safe_change_impact', {
			snapshot: lifecycleSnapshot,
			intent: 'rename',
			target: { file: 'missing.ts', name: 'missing', space: 'value' },
		});
		expect(stale.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'stale-snapshot',
			snapshot: changed.structuredContent?.snapshot,
		});

		const currentSnapshot = changed.structuredContent?.snapshot as string;
		await symlink(join(root, 'leaf.ts'), join(root, 'forbidden.ts'));
		const rejected = await call(lifecycleHarness, 'guessless_prepare_snapshot', {
			rootUri,
		});
		expect(rejected.structuredContent).toMatchObject({
			state: 'refused',
			reason: 'descendant-symlink',
			snapshot: currentSnapshot,
		});
		const preserved = await call(lifecycleHarness, 'guessless_safe_change_impact', {
			snapshot: currentSnapshot,
			intent: 'rename',
			target: { file: 'src/entry.ts', name: 'value', space: 'value' },
		});
		expect(preserved.structuredContent).toMatchObject({
			state: 'complete',
			snapshot: currentSnapshot,
		});
	});
});
