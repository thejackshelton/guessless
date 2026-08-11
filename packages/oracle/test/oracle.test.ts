/**
 * Oracle trust boundaries. Most of this file is environment-independent and runs in the default
 * `pnpm test` gate: path derivation, escape rejection, stage cleanup, redirect and release-identity
 * binding, offline evidence validation, percentiles, and record serialization.
 *
 * The tests marked with `EVIDENCE_ONLY` below are the exception and are opt-in.
 *
 * Verifies (opt-in part): that the production verifier rejects a tampered copy of
 * `docs/evidence/oracle-part-2`, and that offline repair refuses unauthorized manifest hashes.
 *
 * Why opt-in: both paths call `verifyCache()`, which requires the acquired corpus at
 * `.guessless/cache/oracle/oracle-part-2-v1` — third-party repository tarballs fetched from GitHub
 * under explicit network consent and checked against sha256 pins. That cache is untracked and
 * cannot be self-generated or committed (multi-megabyte external archives whose bytes are the point
 * of the pin), so in a fresh checkout these tests fail with ENOENT for a reason that says nothing
 * about the health of the code. Gating changes only when they run; no assertion here is weakened or
 * removed. Populate the cache first with:
 *   GUESSLESS_ORACLE_NETWORK_CONSENT=... pnpm --filter @guessless/oracle exec node dist/cli.js \
 *     acquire --allow-network --evidence-id oracle-part-2-v1
 *
 * Run the opt-in tests with:
 *   GUESSLESS_EVIDENCE_TESTS=1 pnpm test oracle
 *   (or `pnpm test:evidence` for every evidence-era suite at once)
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
	acquire,
	cleanupStage,
	validateMcplsCommit,
	validateMcplsRelease,
	validateRedirect,
	validateSidecar,
} from '../src/acquire.ts';
import {
	assertAllowedUrl,
	assertContained,
	assertSafeChildName,
	deriveOraclePaths,
	ensureRealDirectory,
	exactEvidencePath,
	MCPLS,
	stableJson,
} from '../src/contracts.ts';
import { validateNonbuildEvidence, type NonbuildEvidence } from '../src/corpus.ts';
import {
	promoteDirectoryWithRollback,
	repairEvidence,
	resealEvidenceCopy,
	validateLspEvidence,
	verifyEvidenceCopy,
} from '../src/evidence.ts';
import {
	generateSource,
	percentile,
	serializePerformanceRecord,
	type PerformanceRecord,
} from '../src/performance.ts';

const root = resolve(import.meta.dirname, '../../..');

// Requires the acquired oracle-part-2-v1 corpus cache; see the file header.
const EVIDENCE_ONLY = test.skipIf(process.env.GUESSLESS_EVIDENCE_TESTS !== '1');

const temporary: string[] = [];

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
	const path = mkdtempSync(join(tmpdir(), 'guessless-oracle-test-'));
	temporary.push(path);
	return path;
}

function evidenceCopy(): string {
	const copy = join(scratch(), 'oracle-part-2');
	cpSync(join(root, 'docs/evidence/oracle-part-2'), copy, {
		recursive: true,
		errorOnExist: true,
	});
	return copy;
}

function mutateJsonLines(path: string, mutate: (rows: any[]) => void): void {
	const rows = readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	mutate(rows);
	writeFileSync(path, rows.map((row) => stableJson(row).trimEnd()).join('\n') + '\n');
}

function release(overrides: Record<string, unknown> = {}) {
	return {
		tag_name: MCPLS.tag,
		assets: [
			{
				id: MCPLS.assetId,
				name: MCPLS.assetName,
				size: MCPLS.assetSize,
				content_type: MCPLS.assetContentType,
				browser_download_url: `https://github.com/bug-ops/mcpls/releases/download/${MCPLS.tag}/${MCPLS.assetName}`,
				digest: `sha256:${MCPLS.assetSha256}`,
				...overrides,
			},
			{
				id: 1,
				name: `${MCPLS.assetName}.sha256`,
				size: 100,
				content_type: 'text/plain',
				browser_download_url: `https://github.com/bug-ops/mcpls/releases/download/${MCPLS.tag}/${MCPLS.assetName}.sha256`,
				digest: null,
			},
		],
	};
}

describe('oracle trust boundaries', () => {
	test('derives one canonical root from source and built module locations regardless of cwd/env', () => {
		const originalCwd = process.cwd();
		const changed = scratch();
		const original = {
			PWD: process.env.PWD,
			INIT_CWD: process.env.INIT_CWD,
			npm_config_cache: process.env.npm_config_cache,
		};
		try {
			process.chdir(changed);
			process.env.PWD = '/spoofed/pwd';
			process.env.INIT_CWD = '/spoofed/init';
			process.env.npm_config_cache = '/spoofed/cache';
			for (const modulePath of [
				join(root, 'packages/oracle/src/contracts.ts'),
				join(root, 'packages/oracle/dist/cli.js'),
			]) {
				const paths = deriveOraclePaths(pathToFileURL(modulePath).href);
				expect(paths.root).toBe(realpathSync(root));
				expect(paths.cache).toBe(join(realpathSync(root), '.guessless/cache/oracle'));
				expect(paths.evidence).toBe(
					join(realpathSync(root), 'docs/evidence/oracle-part-2'),
				);
			}
		} finally {
			process.chdir(originalCwd);
			for (const [key, value] of Object.entries(original)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test('rejects layout, child, evidence, symlink, and prefix-confusable escapes', () => {
		const temp = scratch();
		const module = join(temp, 'packages/oracle/other/contracts.ts');
		mkdirSync(join(temp, 'packages/oracle/other'), { recursive: true });
		writeFileSync(module, '');
		expect(() => deriveOraclePaths(pathToFileURL(module).href)).toThrow(/exact/);
		for (const child of [
			'',
			'.',
			'..',
			'../escape',
			'/absolute',
			'sibling/path',
			'sibling\\path',
		])
			expect(() => assertSafeChildName(child)).toThrow();
		expect(() => exactEvidencePath('/tmp/evidence')).toThrow();
		expect(() => exactEvidencePath('../docs/evidence/oracle-part-2')).toThrow();

		const parent = join(temp, 'parent');
		const sibling = join(temp, 'parent-confusable');
		mkdirSync(parent);
		mkdirSync(sibling);
		expect(() => assertContained(parent, sibling)).toThrow();
		const linked = join(parent, 'linked');
		symlinkSync(sibling, linked);
		expect(() => assertContained(parent, linked)).toThrow();
		expect(() => ensureRealDirectory(parent, 'linked')).toThrow(/real directory/);

		const fakeRoot = join(temp, 'fake-root');
		const fakeModule = join(fakeRoot, 'packages/oracle/src/contracts.ts');
		mkdirSync(join(fakeRoot, 'packages/oracle/src'), { recursive: true });
		writeFileSync(fakeModule, '');
		writeFileSync(join(fakeRoot, 'package.json'), '{"name":"wrong"}');
		writeFileSync(
			join(fakeRoot, 'packages/oracle/package.json'),
			'{"name":"@guessless/oracle"}',
		);
		writeFileSync(join(fakeRoot, 'pnpm-workspace.yaml'), 'packages: []');
		expect(() => deriveOraclePaths(pathToFileURL(fakeModule).href)).toThrow(/marker/);
		writeFileSync(join(fakeRoot, 'package.json'), '{"name":"guessless-workspace"}');
		writeFileSync(join(fakeRoot, 'packages/oracle/package.json'), '{"name":"wrong"}');
		expect(() => deriveOraclePaths(pathToFileURL(fakeModule).href)).toThrow(/marker/);
	});

	test('cleans only the exact validated stage and preserves unrelated sentinels', () => {
		const temp = scratch();
		mkdirSync(join(temp, 'oracle'));
		const cache = realpathSync(join(temp, 'oracle'));
		const stageName = '.staging-oracle-part-2-v1-123';
		const stage = join(cache, stageName);
		mkdirSync(stage);
		writeFileSync(join(stage, 'partial'), 'partial');
		writeFileSync(join(cache, 'sentinel'), 'unchanged');
		cleanupStage(cache, stage, stageName);
		expect(existsSync(stage)).toBe(false);
		expect(readFileSync(join(cache, 'sentinel'), 'utf8')).toBe('unchanged');
		expect(() => cleanupStage(cache, cache, stageName)).toThrow();
		const target = join(temp, 'target');
		mkdirSync(target);
		const linkStage = join(cache, stageName);
		symlinkSync(target, linkStage);
		expect(() => cleanupStage(cache, linkStage, stageName)).toThrow();
	});

	test('allows only a bound sanitized exact release-assets redirect', () => {
		const initial = new URL(
			`https://github.com/bug-ops/mcpls/releases/download/${MCPLS.tag}/${MCPLS.assetName}`,
		);
		const signed =
			'https://release-assets.githubusercontent.com/github-production-release-asset/bound/object?jwt=secret&sig=signed';
		const allowed = validateRedirect(
			initial,
			signed,
			{ kind: 'bound-release-asset', initialUrl: initial.href },
			302,
			0,
		);
		expect(allowed.next.href).toBe(signed);
		expect(allowed.ledger).toMatchObject({
			status: 302,
			scheme: 'https:',
			host: 'release-assets.githubusercontent.com',
			path: '/github-production-release-asset/bound/object',
			queryPresent: true,
		});
		expect(JSON.stringify(allowed.ledger)).not.toContain('secret');
		expect(() => assertAllowedUrl(signed)).toThrow();
		for (const location of [
			'http://release-assets.githubusercontent.com/object',
			'https://user:pass@release-assets.githubusercontent.com/object',
			'https://release-assets.githubusercontent.com:444/object',
			'https://evil.release-assets.githubusercontent.com/object',
			'https://release-assets.githubusercontent.com.evil.test/object',
			'https://github.com/arbitrary',
		])
			expect(() =>
				validateRedirect(
					initial,
					location,
					{ kind: 'bound-release-asset', initialUrl: initial.href },
					302,
					0,
				),
			).toThrow();
		expect(() => validateRedirect(initial, signed, { kind: 'general' }, 302, 0)).toThrow();
		expect(() =>
			validateRedirect(
				initial,
				signed,
				{ kind: 'bound-release-asset', initialUrl: initial.href },
				302,
				5,
			),
		).toThrow(/limit/);
	});

	test('binds every mcpls release identity field and rejects missing/wrong values', () => {
		expect(validateMcplsRelease(release()).asset.id).toBe(MCPLS.assetId);
		for (const [field, value] of [
			['id', 1],
			['name', 'wrong.tar.gz'],
			['size', 1],
			['content_type', 'application/octet-stream'],
			['digest', `sha256:${'0'.repeat(64)}`],
			['digest', null],
		] as const)
			expect(() => validateMcplsRelease(release({ [field]: value }))).toThrow();
		expect(() => validateMcplsRelease({ ...release(), tag_name: 'v0.3.6' })).toThrow();
		expect(() => validateMcplsCommit('0'.repeat(40))).toThrow();
		expect(() => validateMcplsCommit(MCPLS.commit)).not.toThrow();
		expect(() =>
			validateSidecar(`f${MCPLS.assetSha256.slice(1)}  ${MCPLS.assetName}`),
		).toThrow();
		expect(() => validateSidecar(`${MCPLS.assetSha256}  ${MCPLS.assetName}`)).not.toThrow();
	});

	test('rejects acquisition without exact consent and proves package-local cache absence', async () => {
		const previous = process.env.GUESSLESS_ORACLE_NETWORK_CONSENT;
		delete process.env.GUESSLESS_ORACLE_NETWORK_CONSENT;
		try {
			await expect(
				acquire(['--allow-network', '--evidence-id', 'oracle-part-2-v1']),
			).rejects.toThrow(/CONSENT/);
		} finally {
			if (previous === undefined) delete process.env.GUESSLESS_ORACLE_NETWORK_CONSENT;
			else process.env.GUESSLESS_ORACLE_NETWORK_CONSENT = previous;
		}
		expect(existsSync(join(root, 'packages/oracle/.guessless'))).toBe(false);
	});

	test('generates exact physical line counts and deterministic bytes', () => {
		for (const lines of [10_000, 100_000]) {
			const first = generateSource(lines);
			const second = generateSource(lines);
			expect(first).toBe(second);
			expect(first.split('\n').length - 1).toBe(lines);
		}
	});

	test('accepts only a reached repository script with an honest missing-tool failure', () => {
		const proxy = 'http://127.0.0.1:9';
		const evidence: NonbuildEvidence = {
			repository: 'fixture',
			selection: 'typecheck>build>test',
			script: 'build',
			command: ['pnpm', 'run', 'build'],
			environment: {
				CI: '1',
				npm_config_offline: 'true',
				npm_config_ignore_scripts: 'true',
				npm_config_enable_pre_post_scripts: 'false',
				http_proxy: proxy,
				https_proxy: proxy,
				all_proxy: proxy,
				HTTP_PROXY: proxy,
				HTTPS_PROXY: proxy,
				ALL_PROXY: proxy,
				NO_PROXY: '',
				no_proxy: '',
			},
			networkIsolation: 'test',
			status: 1,
			signal: null,
			timedOut: false,
			scriptBannerReached: true,
			expectedMissingToolingFailure: true,
			stdout: '> fixture@1.0.0 build\n> missing-tool\n',
			stderr: 'sh: missing-tool: not found\n',
		};
		expect(() => validateNonbuildEvidence(evidence)).not.toThrow();
		expect(() =>
			validateNonbuildEvidence({
				...evidence,
				stderr: "ERROR Unknown option: 'offline'\nFor help, run: pnpm help run\n",
			}),
		).toThrow(/missing tooling/);
		expect(() =>
			validateNonbuildEvidence({
				...evidence,
				command: ['pnpm', '--offline', 'run', 'build'],
			}),
		).toThrow(/command/);
		expect(() =>
			validateNonbuildEvidence({
				...evidence,
				environment: {
					...evidence.environment,
					npm_config_enable_pre_post_scripts: 'true',
				},
			}),
		).toThrow(/offline environment/);
		expect(() =>
			validateNonbuildEvidence({
				...evidence,
				stderr: "Error: Cannot find module 'missing-build-tool'\n",
			}),
		).not.toThrow();
		expect(() =>
			validateNonbuildEvidence({
				...evidence,
				stderr: 'documentation says this tool was not found\n',
			}),
		).toThrow(/missing tooling/);
		for (const mutation of [
			{
				stdout: '> fixture@1.0.0 prebuild\n> npm install\n',
				stderr: 'sh: missing-tool: not found\n',
			},
			{ stdout: evidence.stdout, stderr: 'npm error ENOTCACHED registry.npmjs.org\n' },
		])
			expect(() => validateNonbuildEvidence({ ...evidence, ...mutation })).toThrow(
				/missing tooling/,
			);
	});

	test('recomputes percentiles instead of trusting published values', () => {
		const samples = [9n, 1n, 5n, 2n, 8n, 3n, 7n, 4n, 6n, 10n];
		expect(percentile(samples, 0.5)).toBe(5n);
		expect(percentile(samples, 0.95)).toBe(10n);
	});

	test('serializes performance records as stable compact JSON with exactly one LF', () => {
		const record = {
			z: 1,
			nested: { z: 2, a: 1 },
			a: 2,
		} as unknown as PerformanceRecord;
		const serialized = serializePerformanceRecord(record);
		expect(serialized).toBe('{"a":2,"nested":{"a":1,"z":2},"z":1}\n');
		expect(serialized.endsWith('\n')).toBe(true);
		expect(serialized.endsWith('\n\n')).toBe(false);
	});

	test('rejects a false LSP success flag and transcript/result mismatch', () => {
		const workspace = scratch();
		const position = { file: 'a.js', line: 1, character: 2, symbolName: 'a' };
		const args = { file_path: join(workspace, 'a.js'), line: 1, character: 2 };
		const definition = {
			content: [{ type: 'text', text: '{"locations":[1]}' }],
			isError: false,
		};
		const references = {
			content: [{ type: 'text', text: '{"locations":[2]}' }],
			isError: false,
		};
		const frames = [
			{
				direction: 'stdin' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'initialize',
					params: { protocolVersion: '2024-11-05' },
				}),
			},
			{
				direction: 'stdout' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mcpls' } },
				}),
			},
			{
				direction: 'stdin' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
					params: {},
				}),
			},
			{
				direction: 'stdin' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'get_definition', arguments: args },
				}),
			},
			{
				direction: 'stdout' as const,
				raw: JSON.stringify({ jsonrpc: '2.0', id: 2, result: definition }),
			},
			{
				direction: 'stdin' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'get_references',
						arguments: { ...args, include_declaration: true },
					},
				}),
			},
			{
				direction: 'stdout' as const,
				raw: JSON.stringify({ jsonrpc: '2.0', id: 3, result: references }),
			},
			{
				direction: 'stdin' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						name: 'get_diagnostics',
						arguments: { file_path: join(workspace, 'a.js') },
					},
				}),
			},
			{
				direction: 'stdout' as const,
				raw: JSON.stringify({
					jsonrpc: '2.0',
					id: 4,
					error: { code: -32603, message: 'diagnostic unavailable' },
				}),
			},
		];
		const lsp = {
			repository: 'fixture',
			command: ['mcpls'],
			networkIsolation: 'test',
			config: '',
			workspace,
			position,
			transcript: frames,
			stderr: 'raw',
			definition,
			references,
			diagnostics: {
				error: 'mcpls tools/call: {"code":-32603,"message":"diagnostic unavailable"}',
			},
			usefulSuccess: false,
			honestLimitation:
				'preserved {"error":"mcpls tools/call: {\\"code\\":-32603,\\"message\\":\\"diagnostic unavailable\\"}"}',
		};
		expect(() => validateLspEvidence(lsp, 'fixture', workspace, position, 'raw')).toThrow(
			/useful-success/,
		);
	});

	EVIDENCE_ONLY.each([
		{
			name: 'transcript/result mismatch',
			expected: /LSP transcript result mismatch/,
			mutate(copy: string) {
				const path = join(copy, 'raw/react-boilerplate-v4.mcpls.stdout.jsonl');
				mutateJsonLines(path, ([row]) => {
					const frame = row.transcript.find(
						(item: any) => item.direction === 'stdout' && JSON.parse(item.raw).id === 2,
					);
					frame.raw = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } });
				});
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'wrong percentile',
			expected: /performance scale 10000 percentile mismatch/,
			mutate(copy: string) {
				mutateJsonLines(join(copy, 'raw/performance.jsonl'), ([row]) => {
					row.record.queries.definitionOf.p50Ns = '1';
					row.stdout = serializePerformanceRecord(row.record);
				});
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'missing raw sample',
			expected: /performance scale 10000 raw query samples missing/,
			mutate(copy: string) {
				mutateJsonLines(join(copy, 'raw/performance.jsonl'), ([row]) => {
					row.record.queries.definitionOf.rawNs.pop();
					row.stdout = serializePerformanceRecord(row.record);
				});
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'wrong process cap',
			expected: /performance scale 10000 semantic mismatch/,
			mutate(copy: string) {
				mutateJsonLines(join(copy, 'raw/performance.jsonl'), ([row]) => {
					row.maxOldSpaceMiB += 1;
				});
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'stale census',
			expected: /summary semantic mismatch/,
			mutate(copy: string) {
				const path = join(copy, 'summary.md');
				writeFileSync(
					path,
					readFileSync(path, 'utf8').replace(
						/Receipt-state census: `[^`]+`\./,
						'Receipt-state census: `{}`.',
					),
				);
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'tampered receipt',
			expected: /Guessless semantic evidence failed/,
			mutate(copy: string) {
				mutateJsonLines(join(copy, 'raw/react-boilerplate-v4.guessless.jsonl'), ([row]) => {
					row.receipt.integrity = '0'.repeat(64);
				});
				resealEvidenceCopy(copy);
			},
		},
		{
			name: 'stale manifest',
			expected: /manifest file set\/hash mismatch/,
			mutate(copy: string) {
				const path = join(copy, 'summary.md');
				writeFileSync(path, `${readFileSync(path, 'utf8')}x`);
			},
		},
	])(
		'production verifier rejects $name',
		({ mutate, expected }) => {
			const copy = evidenceCopy();
			mutate(copy);
			expect(() => verifyEvidenceCopy(copy)).toThrow(expected);
		},
		15_000,
	);

	test('production promotion rolls back and preserves an unrelated sentinel', () => {
		const parent = scratch();
		const final = join(parent, 'final');
		const stage = join(parent, 'stage');
		mkdirSync(final);
		mkdirSync(stage);
		writeFileSync(join(final, 'identity'), 'old');
		writeFileSync(join(stage, 'identity'), 'replacement');
		writeFileSync(join(parent, 'sentinel'), 'unchanged');
		expect(() =>
			promoteDirectoryWithRollback(parent, stage, final, '.superseded-test', () => {
				throw new Error('verification failed');
			}),
		).toThrow(/verification failed/);
		expect(readFileSync(join(final, 'identity'), 'utf8')).toBe('old');
		expect(readFileSync(join(stage, 'identity'), 'utf8')).toBe('replacement');
		expect(readFileSync(join(parent, 'sentinel'), 'utf8')).toBe('unchanged');
		expect(existsSync(join(parent, '.superseded-test'))).toBe(false);
	});

	EVIDENCE_ONLY('rejects closed and unknown repair manifest preconditions', async () => {
		const previous = process.env.GUESSLESS_ORACLE_NETWORK_CONSENT;
		process.env.GUESSLESS_ORACLE_NETWORK_CONSENT = 'disabled';
		try {
			for (const hash of [
				'0'.repeat(64),
				'f891b559c2218596e0fa84f4429d0ef04575b3dcc261fc64dd369130bdf71eec',
			])
				await expect(
					repairEvidence(
						[
							'--offline',
							'--evidence-dir',
							'docs/evidence/oracle-part-2',
							'--expected-manifest-sha256',
							hash,
						],
						join(root, 'packages/oracle/dist/cli.js'),
					),
				).rejects.toThrow(/authorized hash/);
		} finally {
			if (previous === undefined) delete process.env.GUESSLESS_ORACLE_NETWORK_CONSENT;
			else process.env.GUESSLESS_ORACLE_NETWORK_CONSENT = previous;
		}
	});
});
