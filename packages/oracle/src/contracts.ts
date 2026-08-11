import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ID = 'oracle-part-2-v1';
export const NETWORK_CONSENT = EVIDENCE_ID;
export const CACHE_RELATIVE = '.guessless/cache/oracle';
export const EVIDENCE_RELATIVE = 'docs/evidence/oracle-part-2';
export const GENERATOR_VERSION = 'guessless-synthetic-ts/v1';
export const GENERATOR_SEED = 0x47554553;
export const PERFORMANCE_LINES = [10_000, 100_000, 1_000_000] as const;

export interface RepositoryPin {
	readonly id: string;
	readonly owner: string;
	readonly repository: string;
	readonly commit: string;
	readonly archiveSha256: string;
	readonly licensePath: string;
	readonly licenseSha256: string;
}

export const REPOSITORIES: readonly RepositoryPin[] = [
	{
		id: 'react-boilerplate-v4',
		owner: 'react-boilerplate',
		repository: 'react-boilerplate',
		commit: 'd19099afeff64ecfb09133c06c1cb18c0d40887e',
		archiveSha256: 'd6ca60a3c8881ae2be26a8d04e00da4d922a6653f8512f2b12ac55d48f2ce2d5',
		licensePath: 'LICENSE.md',
		licenseSha256: 'e773e6b91c13f55310668e15ce178a2fcf779ff39dbcc0b910b4b5f1ecb17acb',
	},
	{
		id: 'react-realworld-cra1',
		owner: 'gothinkster',
		repository: 'react-redux-realworld-example-app',
		commit: 'ee72eba4056392c95a27bc48d385d3f54ba38a18',
		archiveSha256: '67a0375d948c250a0e7d79c9024327239a223ee84c66111aae132b11144f932f',
		licensePath: 'LICENSE.md',
		licenseSha256: '3bc29327b728ee0729f65d5b7261a7445f4a44fd7fd09462883b19e42c34caa4',
	},
	{
		id: 'angular-phonecat',
		owner: 'angular',
		repository: 'angular-phonecat',
		commit: 'ef6f6eb672ded472b4e442d598f5df40d0e0642c',
		archiveSha256: 'c7624a333ddfaa31f51385e72b8966162171e798ec63a1b991ec4bde26339eb1',
		licensePath: 'LICENSE',
		licenseSha256: 'bab10b0aa126d9fdb81380141fc8845a74024d7c9977e5636afd06fe5edce455',
	},
] as const;

export const MCPLS = {
	owner: 'bug-ops',
	repository: 'mcpls',
	tag: 'v0.3.5',
	commit: '82358fc9436914acba05bdb00934eeca6997dace',
	assetId: 375_958_255,
	assetName: 'mcpls-aarch64-apple-darwin.tar.gz',
	assetSize: 1_880_846,
	assetContentType: 'application/gzip',
	assetSha256: '0d21b3cb8e4ba77395a04739e28a68d6ec76cdd699098f2298300fd4806e42fe',
} as const;

export const ALLOWED_NETWORK_HOSTS = new Set([
	'api.github.com',
	'codeload.github.com',
	'github.com',
	'registry.npmjs.org',
]);

export interface RedirectHop {
	readonly status: number;
	readonly scheme: 'https:';
	readonly host: string;
	readonly path: string;
	readonly queryPresent: boolean;
	readonly locationSha256: string;
}

export interface CacheMetadata {
	readonly evidenceId: typeof EVIDENCE_ID;
	readonly acquiredAt: string;
	readonly repositories: readonly (RepositoryPin & {
		readonly archiveUrl: string;
		readonly sourceDir: string;
		readonly sourceFileCount: number;
		readonly dependencyDirectories: readonly string[];
	})[];
	readonly mcpls: {
		readonly tag: string;
		readonly commit: string;
		readonly assetId: number;
		readonly assetName: string;
		readonly assetSize: number;
		readonly assetUrl: string;
		readonly officialDigest: string;
		readonly actualSha256: string;
		readonly binaryPath: string;
		readonly versionStdout: string;
		readonly versionStderr: string;
		readonly versionStatus: number | null;
		readonly licenses: readonly {
			readonly path: string;
			readonly sha256: string;
			readonly text: string;
		}[];
		readonly releaseJson: unknown;
		readonly redirectHops: readonly RedirectHop[];
		readonly sidecarName: string;
		readonly sidecarSha256Text: string;
	};
	readonly tools: {
		readonly node: string;
		readonly pnpm: string;
		readonly typescript: '5.9.3';
		readonly typescriptLanguageServer: '5.3.0';
		readonly pathe: '2.0.3';
		readonly ufo: '1.6.4';
	};
}

export interface ManifestEntry {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface EvidenceManifest {
	readonly schema: 'guessless.oracle-evidence/v1';
	readonly evidenceId: typeof EVIDENCE_ID;
	readonly files: readonly ManifestEntry[];
}

export interface OraclePaths {
	readonly root: string;
	readonly oraclePackage: string;
	readonly cache: string;
	readonly evidence: string;
}

function assertRealFile(path: string, label: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
}

function readPackageName(path: string, expected: string): void {
	assertRealFile(path, path);
	const value = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown };
	if (value.name !== expected) throw new Error(`${path} package name marker mismatch`);
}

export function assertSafeChildName(name: string): string {
	if (
		name.length === 0 ||
		name === '.' ||
		name === '..' ||
		isAbsolute(name) ||
		name.includes('/') ||
		name.includes('\\') ||
		name.includes('\0')
	)
		throw new Error(`unsafe child name '${name}'`);
	return name;
}

export function assertContained(parent: string, candidate: string): void {
	const parentReal = realpathSync(parent);
	const candidateReal = realpathSync(candidate);
	const fromParent = relative(parentReal, candidateReal);
	if (
		fromParent === '' ||
		fromParent === '..' ||
		fromParent.startsWith(`..${sep}`) ||
		isAbsolute(fromParent)
	)
		throw new Error(`${candidate} escapes exact parent ${parent}`);
}

export function ensureRealDirectory(parent: string, childName: string): string {
	assertSafeChildName(childName);
	const parentStat = lstatSync(parent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
		throw new Error(`${parent} must be a real directory`);
	const parentReal = realpathSync(parent);
	const child = join(parentReal, childName);
	if (!existsSync(child)) mkdirSync(child);
	const childStat = lstatSync(child);
	if (!childStat.isDirectory() || childStat.isSymbolicLink())
		throw new Error(`${child} must be a real directory`);
	assertContained(parentReal, child);
	return realpathSync(child);
}

export function deriveOraclePaths(moduleUrl = import.meta.url): OraclePaths {
	const modulePath = realpathSync(fileURLToPath(moduleUrl));
	assertRealFile(modulePath, 'oracle executing module');
	const moduleDirectory = dirname(modulePath);
	const locationName = moduleDirectory.slice(moduleDirectory.lastIndexOf(sep) + 1);
	if (locationName !== 'src' && locationName !== 'dist')
		throw new Error('oracle module must execute from exact packages/oracle/src or dist');
	const oraclePackage = dirname(moduleDirectory);
	if (
		oraclePackage.slice(oraclePackage.lastIndexOf(sep) + 1) !== 'oracle' ||
		dirname(oraclePackage).slice(dirname(oraclePackage).lastIndexOf(sep) + 1) !== 'packages'
	)
		throw new Error('oracle module-relative package layout mismatch');
	const root = resolve(moduleDirectory, '..', '..', '..');
	if (realpathSync(root) !== root) throw new Error('canonical repository root mismatch');
	readPackageName(join(root, 'package.json'), 'guessless-workspace');
	readPackageName(join(oraclePackage, 'package.json'), '@guessless/oracle');
	assertRealFile(join(root, 'pnpm-workspace.yaml'), 'workspace marker');
	return {
		root,
		oraclePackage,
		cache: join(root, CACHE_RELATIVE),
		evidence: join(root, EVIDENCE_RELATIVE),
	};
}

export function ensureCacheRoot(paths = deriveOraclePaths()): string {
	const dotGuessless = ensureRealDirectory(paths.root, '.guessless');
	const cache = ensureRealDirectory(dotGuessless, 'cache');
	const oracle = ensureRealDirectory(cache, 'oracle');
	if (oracle !== realpathSync(paths.cache)) throw new Error('cache path identity mismatch');
	return oracle;
}

export function exactEvidencePath(value: string | undefined, paths = deriveOraclePaths()): string {
	if (value !== EVIDENCE_RELATIVE)
		throw new Error(`evidence directory must be exactly ${EVIDENCE_RELATIVE}`);
	return paths.evidence;
}

export function networkIsolatedCommand(
	command: readonly string[],
	writableScratch: string,
): { readonly command: readonly string[]; readonly mechanism: string } {
	if (
		process.env.CODEX_SANDBOX === 'seatbelt' &&
		process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1'
	)
		return { command, mechanism: 'inherited-codex-seatbelt-network-disabled' };
	const profile = `(version 1)(deny default)(allow process*)(allow file-read*)(allow file-write* (subpath "${writableScratch}"))(deny network*)`;
	return {
		command: ['sandbox-exec', '-p', profile, ...command],
		mechanism: 'sandbox-exec-deny-network',
	};
}

export function sha256Bytes(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): string {
	return sha256Bytes(readFileSync(path));
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sortJson(nested)]),
	);
}

export function assertExactSha(actual: string, expected: string, label: string): void {
	if (actual !== expected)
		throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`);
}

export function assertOffline(): void {
	if (process.env.GUESSLESS_ORACLE_NETWORK_CONSENT !== 'disabled')
		throw new Error('offline commands require GUESSLESS_ORACLE_NETWORK_CONSENT=disabled');
}

export function assertNetworkConsent(allowNetwork: boolean, evidenceId: string | undefined): void {
	if (
		!allowNetwork ||
		evidenceId !== EVIDENCE_ID ||
		process.env.GUESSLESS_ORACLE_NETWORK_CONSENT !== NETWORK_CONSENT
	)
		throw new Error(
			`acquisition requires GUESSLESS_ORACLE_NETWORK_CONSENT=${NETWORK_CONSENT}, --allow-network, and --evidence-id ${EVIDENCE_ID}`,
		);
}

export function assertAllowedUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || !ALLOWED_NETWORK_HOSTS.has(url.hostname))
		throw new Error(`network URL is outside the HTTPS allowlist: ${value}`);
	return url;
}

export function parseFlag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}
