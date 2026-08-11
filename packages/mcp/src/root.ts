import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, normalize, relative } from 'pathe';
import { parseURL } from 'ufo';

const supportedSource = /\.(?:[cm]?[jt]s|jsx|tsx)$/;
const excludedDirectoryNames = ['.git', '.guessless', 'node_modules'] as const;

export const ROOT_SCAN_POLICY = Object.freeze({
	name: 'guessless-root-scan',
	version: 1,
	includedLanguages: Object.freeze(['js', 'jsx', 'ts', 'tsx', 'cjs', 'cts', 'mjs', 'mts']),
	excludedDirectoryNames: Object.freeze([...excludedDirectoryNames]),
	maxFiles: 256,
	maxEntries: 8192,
	maxIndexedBytes: 4 * 1024 * 1024,
	maxScannedBytes: 16 * 1024 * 1024,
	maxDepth: 64,
});

export type RootPreparationReason =
	| 'invalid-root-uri'
	| 'outside-configured-root'
	| 'root-symlink'
	| 'descendant-symlink'
	| 'unreadable-entry'
	| 'special-file'
	| 'invalid-utf8'
	| 'path-collision'
	| 'resource-limit'
	| 'unstable-scan';

export interface RootCoverage {
	readonly path: string;
	readonly sourceSha256: string;
}

export interface StableRootScan {
	readonly rootUri: string;
	readonly policy: typeof ROOT_SCAN_POLICY;
	readonly scanDigest: string;
	readonly coverage: readonly RootCoverage[];
	readonly files: readonly { path: string; source: string; sourceSha256: string }[];
	readonly fileCount: number;
	readonly indexedBytes: number;
	readonly outsideLanguageBoundary: readonly string[];
	readonly excludedDirectories: readonly string[];
}

export interface RootScanRefusal {
	readonly state: 'refused';
	readonly reason: RootPreparationReason;
	readonly detail: string;
	readonly rootUri: string | null;
}

class ScanError extends Error {
	constructor(
		readonly reason: RootPreparationReason,
		message: string,
	) {
		super(message);
	}
}

interface ScanEntry {
	readonly path: string;
	readonly kind: 'included' | 'outside-language-boundary';
	readonly sha256: string;
}

interface OneScan extends StableRootScan {
	readonly entries: readonly ScanEntry[];
}

export interface PathCollision {
	readonly prior: string;
	readonly path: string;
}

export interface CanonicalPathTracker {
	add(path: string): PathCollision | null;
}

export function createCanonicalPathTracker(): CanonicalPathTracker {
	const paths = new Map<string, string>();
	return {
		add(path) {
			const key = path.normalize('NFC').toLocaleLowerCase('en-US');
			const prior = paths.get(key);
			if (prior !== undefined && prior !== path) return { prior, path };
			paths.set(key, path);
			return null;
		},
	};
}

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`;
	return JSON.stringify(value);
}

function parseCanonicalRootUri(rootUri: string): string {
	let parsed: ReturnType<typeof parseURL>;
	try {
		parsed = parseURL(rootUri);
	} catch {
		throw new ScanError('invalid-root-uri', 'Root URI could not be parsed.');
	}
	if (parsed.protocol !== 'file:' || parsed.auth || parsed.host)
		throw new ScanError(
			'invalid-root-uri',
			'Root URI must be a credential-free local file URI.',
		);
	if (parsed.search || parsed.hash)
		throw new ScanError('invalid-root-uri', 'Root URI cannot contain a query or fragment.');
	if (/%(?![\dA-Fa-f]{2})/.test(parsed.pathname))
		throw new ScanError('invalid-root-uri', 'Root URI contains malformed percent encoding.');
	let path: string;
	try {
		path = decodeURIComponent(parsed.pathname);
	} catch {
		throw new ScanError('invalid-root-uri', 'Root URI contains malformed encoded bytes.');
	}
	if (!isAbsolute(path) || path.includes('\0'))
		throw new ScanError('invalid-root-uri', 'Root URI path must be absolute.');
	const normalized = normalize(path);
	if (pathToFileURL(normalized).href !== rootUri)
		throw new ScanError('invalid-root-uri', 'Root URI is not in canonical local file form.');
	return normalized;
}

function isContained(configuredRoot: string, requestedRoot: string): boolean {
	const path = relative(configuredRoot, requestedRoot);
	return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

function statIdentity(stat: {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	mode: bigint;
}): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.mode}`;
}

async function readStableFile(path: string): Promise<Buffer> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) throw new ScanError('special-file', `Non-regular entry '${path}'.`);
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		if (statIdentity(before) !== statIdentity(after))
			throw new ScanError('unstable-scan', `File '${path}' changed while being read.`);
		return bytes;
	} catch (error) {
		if (error instanceof ScanError) throw error;
		throw new ScanError('unreadable-entry', `Could not read regular file '${path}'.`);
	} finally {
		await handle?.close();
	}
}

async function scanOnce(rootPath: string, rootUri: string): Promise<OneScan> {
	let rootStat;
	try {
		rootStat = await lstat(rootPath, { bigint: true });
	} catch {
		throw new ScanError('unreadable-entry', 'Root cannot be inspected.');
	}
	if (rootStat.isSymbolicLink()) throw new ScanError('root-symlink', 'Root cannot be a symlink.');
	if (!rootStat.isDirectory()) throw new ScanError('special-file', 'Root must be a directory.');
	const files: Array<{ path: string; source: string; sourceSha256: string }> = [];
	const entries: ScanEntry[] = [];
	const outsideLanguageBoundary: string[] = [];
	const excludedDirectories: string[] = [];
	const collisionTracker = createCanonicalPathTracker();
	let indexedBytes = 0;
	let scannedBytes = 0;
	let entryCount = 0;

	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > ROOT_SCAN_POLICY.maxDepth)
			throw new ScanError('resource-limit', 'Directory depth exceeds the frozen scan limit.');
		let directoryHandle;
		try {
			directoryHandle = await opendir(directory);
			const names: string[] = [];
			for await (const entry of directoryHandle) names.push(entry.name);
			names.sort((left, right) => left.localeCompare(right));
			for (const name of names) {
				entryCount += 1;
				if (entryCount > ROOT_SCAN_POLICY.maxEntries)
					throw new ScanError(
						'resource-limit',
						'Entry count exceeds the frozen scan limit.',
					);
				const absolute = join(directory, name);
				let stat;
				try {
					stat = await lstat(absolute, { bigint: true });
				} catch {
					throw new ScanError(
						'unreadable-entry',
						`Entry '${absolute}' cannot be inspected.`,
					);
				}
				if (stat.isSymbolicLink())
					throw new ScanError(
						'descendant-symlink',
						`Symlink '${absolute}' is forbidden.`,
					);
				const logical = normalize(relative(rootPath, absolute));
				if (
					logical === '' ||
					logical === '.' ||
					isAbsolute(logical) ||
					logical === '..' ||
					logical.startsWith('../')
				)
					throw new ScanError('path-collision', `Entry '${absolute}' escapes the root.`);
				const collision = collisionTracker.add(logical);
				if (collision !== null)
					throw new ScanError(
						'path-collision',
						`Paths '${collision.prior}' and '${collision.path}' collide canonically or by case.`,
					);
				if (stat.isDirectory()) {
					if ((excludedDirectoryNames as readonly string[]).includes(name)) {
						excludedDirectories.push(logical);
						continue;
					}
					await visit(absolute, depth + 1);
					continue;
				}
				if (!stat.isFile())
					throw new ScanError(
						'special-file',
						`Special filesystem entry '${logical}' is forbidden.`,
					);
				const bytes = await readStableFile(absolute);
				scannedBytes += bytes.byteLength;
				if (scannedBytes > ROOT_SCAN_POLICY.maxScannedBytes)
					throw new ScanError(
						'resource-limit',
						'Scanned bytes exceed the frozen scan limit.',
					);
				const digest = sha256(bytes);
				if (!supportedSource.test(logical)) {
					outsideLanguageBoundary.push(logical);
					entries.push({
						path: logical,
						kind: 'outside-language-boundary',
						sha256: digest,
					});
					continue;
				}
				if (files.length + 1 > ROOT_SCAN_POLICY.maxFiles)
					throw new ScanError(
						'resource-limit',
						'Source count exceeds the frozen scan limit.',
					);
				indexedBytes += bytes.byteLength;
				if (indexedBytes > ROOT_SCAN_POLICY.maxIndexedBytes)
					throw new ScanError(
						'resource-limit',
						'Indexed bytes exceed the frozen scan limit.',
					);
				let source: string;
				try {
					source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				} catch {
					throw new ScanError('invalid-utf8', `Source '${logical}' is not valid UTF-8.`);
				}
				if (!Buffer.from(source, 'utf8').equals(bytes))
					throw new ScanError(
						'invalid-utf8',
						`Source '${logical}' cannot be decoded losslessly.`,
					);
				files.push({ path: logical, source, sourceSha256: digest });
				entries.push({ path: logical, kind: 'included', sha256: digest });
			}
		} catch (error) {
			if (error instanceof ScanError) throw error;
			throw new ScanError('unreadable-entry', `Directory '${directory}' cannot be scanned.`);
		} finally {
			await directoryHandle?.close().catch(() => undefined);
		}
	};

	await visit(rootPath, 0);
	files.sort((left, right) => left.path.localeCompare(right.path));
	entries.sort((left, right) => left.path.localeCompare(right.path));
	outsideLanguageBoundary.sort((left, right) => left.localeCompare(right));
	excludedDirectories.sort((left, right) => left.localeCompare(right));
	const coverage = files.map(({ path, sourceSha256 }) => ({ path, sourceSha256 }));
	const scanDigest = sha256(
		stableJson({
			rootUri,
			policy: ROOT_SCAN_POLICY,
			entries,
			excludedDirectories,
			indexedBytes,
			scannedBytes,
		}),
	);
	return {
		rootUri,
		policy: ROOT_SCAN_POLICY,
		scanDigest,
		coverage,
		files,
		fileCount: files.length,
		indexedBytes,
		outsideLanguageBoundary,
		excludedDirectories,
		entries,
	};
}

export async function scanStableRoot(
	rootUri: string,
	configuredRoot = process.cwd(),
	betweenScans?: () => void | Promise<void>,
): Promise<StableRootScan | RootScanRefusal> {
	let canonicalRootUri: string | null = null;
	try {
		const requestedPath = parseCanonicalRootUri(rootUri);
		const requestedStat = await lstat(requestedPath, { bigint: true });
		if (requestedStat.isSymbolicLink())
			throw new ScanError('root-symlink', 'Root cannot be a symlink.');
		const [rootPath, configuredPath] = await Promise.all([
			realpath(requestedPath),
			realpath(configuredRoot),
		]);
		canonicalRootUri = pathToFileURL(rootPath).href;
		if (rootPath !== requestedPath || canonicalRootUri !== rootUri)
			throw new ScanError(
				'root-symlink',
				'Root path traverses a symlink or is non-canonical.',
			);
		if (!isContained(configuredPath, rootPath))
			throw new ScanError(
				'outside-configured-root',
				'Root is outside the configured working root.',
			);
		const first = await scanOnce(rootPath, canonicalRootUri);
		await betweenScans?.();
		const second = await scanOnce(rootPath, canonicalRootUri);
		if (first.scanDigest !== second.scanDigest)
			throw new ScanError(
				'unstable-scan',
				'Two-pass root scans produced different identities.',
			);
		return second;
	} catch (error) {
		return {
			state: 'refused',
			reason: error instanceof ScanError ? error.reason : 'unreadable-entry',
			detail: error instanceof Error ? error.message : String(error),
			rootUri: canonicalRootUri,
		};
	}
}
