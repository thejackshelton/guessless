import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { verifySafeChangeSummary } from '../../engine/src/index.ts';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const clients: Client[] = [];

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

async function createCorpus(): Promise<{ root: string; files: Map<string, string> }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'guessless-warm-')));
	roots.push(root);
	const files = frozenCorpus();
	for (const [path, source] of files) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	await writeFile(join(root, 'README.md'), 'outside-v1');
	for (const directory of ['.git', '.guessless', 'node_modules']) {
		await mkdir(join(root, directory), { recursive: true });
		await writeFile(join(root, directory, 'ignored.ts'), 'export const ignored = 1;');
	}
	return { root, files };
}

async function stdioClient(root: string): Promise<Client> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
		cwd: root,
		stderr: 'pipe',
	});
	const client = new Client({ name: 'guessless-warm-test', version: '0.0.1' });
	await client.connect(transport);
	clients.push(client);
	return client;
}

async function call(
	client: Client,
	name: string,
	arguments_: Record<string, unknown>,
): Promise<CallToolResult> {
	return client.callTool({ name, arguments: arguments_ }) as Promise<CallToolResult>;
}

function impactArguments(snapshot: string, intent: 'rename' | 'delete' | 'entry-point') {
	return {
		snapshot,
		intent,
		target: {
			file: intent === 'entry-point' ? 'src/entry.ts' : 'src/core.ts',
			name: intent === 'entry-point' ? 'entry' : 'mutableTarget',
			space: 'value',
		},
	};
}

function expectedCoverage(files: ReadonlyMap<string, string>) {
	return [...files]
		.map(([path, source]) => ({
			path,
			sourceSha256: createHash('sha256').update(source).digest('hex'),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('immutable warm snapshots', () => {
	test('proves byte-identical one-call warm receipts after exact two-call cold workflows', async () => {
		for (const intent of ['rename', 'delete', 'entry-point'] as const) {
			const { root } = await createCorpus();
			const client = await stdioClient(root);
			const coldCalls: string[] = [];
			const prepared = await call(client, 'guessless_prepare_snapshot', {
				rootUri: pathToFileURL(root).href,
			});
			coldCalls.push('guessless_prepare_snapshot');
			const snapshot = prepared.structuredContent?.snapshot as string;
			const arguments_ = impactArguments(snapshot, intent);
			const cold = await call(client, 'guessless_safe_change_impact', arguments_);
			coldCalls.push('guessless_safe_change_impact');
			expect(coldCalls).toEqual([
				'guessless_prepare_snapshot',
				'guessless_safe_change_impact',
			]);
			let warmCalls = 0;
			const warm = await call(client, 'guessless_safe_change_impact', arguments_);
			warmCalls += 1;
			expect(warmCalls).toBe(1);
			expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
			expect(warm).toEqual(cold);
		}
	});

	test('delivers one-call summaries for every intent with optional exact expansion', async () => {
		const { root } = await createCorpus();
		const client = await stdioClient(root);
		const prepared = await call(client, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		const snapshot = prepared.structuredContent?.snapshot as string;
		for (const intent of ['rename', 'delete', 'entry-point'] as const) {
			const arguments_ = impactArguments(snapshot, intent);
			const full = await call(client, 'guessless_safe_change_impact', arguments_);
			let initialCalls = 0;
			const summary = await call(client, 'guessless_safe_change_impact', {
				...arguments_,
				view: 'summary',
			});
			initialCalls += 1;
			expect(initialCalls).toBe(1);
			expect(verifySafeChangeSummary(summary.structuredContent)).toBe(true);
			expect(summary.structuredContent).toMatchObject({
				state: full.structuredContent?.state,
				request: full.structuredContent?.request,
				snapshot,
				proofHandle: full.structuredContent?.integrity,
			});
			const expanded = await call(client, 'guessless_expand_safe_change_proof', {
				proofHandle: summary.structuredContent?.proofHandle,
			});
			expect(expanded).toEqual(full);
		}
	});

	test('invalidates old handles for content, restored-mtime, add, delete, and rename reparations', async () => {
		const mutations: Array<{
			name: string;
			apply(root: string, files: Map<string, string>): Promise<void>;
		}> = [
			{
				name: 'content',
				async apply(root, files) {
					const path = 'src/core.ts';
					const source = files
						.get(path)!
						.replace('mutableTarget = 1', 'mutableTarget = 2');
					files.set(path, source);
					await writeFile(join(root, path), source);
				},
			},
			{
				name: 'same-length-restored-mtime',
				async apply(root, files) {
					const path = 'src/core.ts';
					const absolute = join(root, path);
					const before = await stat(absolute);
					const source = files
						.get(path)!
						.replace('mutableTarget = 1', 'mutableTarget = 9');
					expect(Buffer.byteLength(source)).toBe(Buffer.byteLength(files.get(path)!));
					files.set(path, source);
					await writeFile(absolute, source);
					await utimes(absolute, before.atime, before.mtime);
				},
			},
			{
				name: 'add',
				async apply(root, files) {
					const path = 'src/added.ts';
					const source = 'export const added = true;';
					files.set(path, source);
					await writeFile(join(root, path), source);
				},
			},
			{
				name: 'delete',
				async apply(root, files) {
					const path = 'src/filler-00.ts';
					files.delete(path);
					await unlink(join(root, path));
				},
			},
			{
				name: 'rename',
				async apply(root, files) {
					const from = 'src/filler-01.js';
					const to = 'src/renamed-01.js';
					files.set(to, files.get(from)!);
					files.delete(from);
					await rename(join(root, from), join(root, to));
				},
			},
		];

		for (const mutation of mutations) {
			const { root, files } = await createCorpus();
			const client = await stdioClient(root);
			const before = await call(client, 'guessless_prepare_snapshot', {
				rootUri: pathToFileURL(root).href,
			});
			const oldSnapshot = before.structuredContent?.snapshot as string;
			await mutation.apply(root, files);
			const after = await call(client, 'guessless_prepare_snapshot', {
				rootUri: pathToFileURL(root).href,
			});
			expect(after.structuredContent?.coverage, mutation.name).toEqual(
				expectedCoverage(files),
			);
			expect(after.structuredContent?.snapshot, mutation.name).not.toBe(oldSnapshot);
			const stale = await call(
				client,
				'guessless_safe_change_impact',
				impactArguments(oldSnapshot, 'rename'),
			);
			expect(stale.structuredContent, mutation.name).toMatchObject({
				state: 'refused',
				reason: 'stale-snapshot',
				snapshot: after.structuredContent?.snapshot,
			});
		}
	});

	test('refused trust and stability reparations preserve the committed snapshot', async () => {
		const { root } = await createCorpus();
		const client = await stdioClient(root);
		const prepared = await call(client, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		const snapshot = prepared.structuredContent?.snapshot as string;
		const arguments_ = impactArguments(snapshot, 'rename');
		const baseline = await call(client, 'guessless_safe_change_impact', arguments_);

		const assertAtomicRefusal = async (reason: string) => {
			const refused = await call(client, 'guessless_prepare_snapshot', {
				rootUri: pathToFileURL(root).href,
			});
			expect(refused.structuredContent).toMatchObject({ state: 'refused', reason, snapshot });
			expect(await call(client, 'guessless_safe_change_impact', arguments_)).toEqual(
				baseline,
			);
		};

		await symlink(join(root, 'src/core.ts'), join(root, 'src/symlink.ts'));
		await assertAtomicRefusal('descendant-symlink');
		await unlink(join(root, 'src/symlink.ts'));

		await writeFile(join(root, 'src/invalid.ts'), Uint8Array.from([0xff]));
		await assertAtomicRefusal('invalid-utf8');
		await unlink(join(root, 'src/invalid.ts'));

		const pipe = join(root, 'src/pipe');
		await execFileAsync('/usr/bin/mkfifo', [pipe]);
		await assertAtomicRefusal('special-file');
		await unlink(pipe);

		const unreadable = join(root, 'src/unreadable.ts');
		await writeFile(unreadable, 'export const unreadable = true;');
		await chmod(unreadable, 0);
		await assertAtomicRefusal('unreadable-entry');
		await chmod(unreadable, 0o600);
		await unlink(unreadable);

		const overflow = join(root, 'overflow');
		await mkdir(overflow);
		await Promise.all(
			Array.from({ length: 257 }, (_, index) =>
				writeFile(
					join(overflow, `${index}.ts`),
					`export const overflow${index} = ${index};`,
				),
			),
		);
		await assertAtomicRefusal('resource-limit');
		await rm(overflow, { recursive: true, force: true });

		const volatile = join(root, 'src/volatile.ts');
		const prefix = '/*';
		const suffix = '*/';
		const bodyLength = 3 * 1024 * 1024 - prefix.length - suffix.length;
		const variants = [
			`${prefix}${'a'.repeat(bodyLength)}${suffix}`,
			`${prefix}${'b'.repeat(bodyLength)}${suffix}`,
		];
		await writeFile(volatile, variants[0]);
		let active = true;
		const churn = (async () => {
			let index = 0;
			while (active) {
				await writeFile(volatile, variants[index % 2]);
				index += 1;
			}
		})();
		try {
			await assertAtomicRefusal('unstable-scan');
		} finally {
			active = false;
			await churn;
		}
	});

	test('describes outside-language and excluded-directory changes without false semantic invalidation', async () => {
		const { root } = await createCorpus();
		const client = await stdioClient(root);
		const first = await call(client, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		const snapshot = first.structuredContent?.snapshot as string;
		const arguments_ = impactArguments(snapshot, 'rename');
		const baseline = await call(client, 'guessless_safe_change_impact', arguments_);

		await writeFile(join(root, 'README.md'), 'outside-v2');
		const outside = await call(client, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		expect(outside.structuredContent).toMatchObject({
			state: 'complete',
			snapshot,
			outsideLanguageBoundary: ['README.md'],
		});
		expect(outside.structuredContent?.scanDigest).not.toBe(first.structuredContent?.scanDigest);
		expect(await call(client, 'guessless_safe_change_impact', arguments_)).toEqual(baseline);

		await writeFile(join(root, '.git/ignored.ts'), 'export const ignored = 2;');
		const excluded = await call(client, 'guessless_prepare_snapshot', {
			rootUri: pathToFileURL(root).href,
		});
		expect(excluded.structuredContent).toMatchObject({
			state: 'complete',
			snapshot,
			excludedRootPolicy: {
				encountered: ['.git', '.guessless', 'node_modules'],
			},
		});
		expect(excluded.structuredContent?.scanDigest).toBe(outside.structuredContent?.scanDigest);
		expect(await readFile(join(root, '.git/ignored.ts'), 'utf8')).toContain('ignored = 2');
		expect(await call(client, 'guessless_safe_change_impact', arguments_)).toEqual(baseline);
	});
});
