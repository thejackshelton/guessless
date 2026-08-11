import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'pathe';
import { parseURL } from 'ufo';
import {
	assertAllowedUrl,
	assertContained,
	assertExactSha,
	assertNetworkConsent,
	assertSafeChildName,
	deriveOraclePaths,
	ensureCacheRoot,
	EVIDENCE_ID,
	MCPLS,
	REPOSITORIES,
	sha256Bytes,
	sha256File,
	stableJson,
	type CacheMetadata,
	type RedirectHop,
} from './contracts.ts';

interface GitHubAsset {
	id: number;
	name: string;
	size: number;
	content_type: string;
	browser_download_url: string;
	digest?: string | null;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubAsset[];
}

export function validateMcplsRelease(release: GitHubRelease): {
	readonly asset: GitHubAsset;
	readonly sidecar: GitHubAsset;
	readonly sidecarName: string;
} {
	if (release.tag_name !== MCPLS.tag) throw new Error('mcpls release tag mismatch');
	const asset = release.assets.find((candidate) => candidate.id === MCPLS.assetId);
	if (
		asset === undefined ||
		asset.name !== MCPLS.assetName ||
		asset.size !== MCPLS.assetSize ||
		asset.content_type !== MCPLS.assetContentType ||
		asset.digest !== `sha256:${MCPLS.assetSha256}`
	)
		throw new Error('mcpls release asset identity or official digest mismatch');
	const sidecarName = `${MCPLS.assetName}.sha256`;
	const sidecars = release.assets.filter((candidate) => candidate.name === sidecarName);
	if (sidecars.length !== 1) throw new Error('mcpls official SHA-256 sidecar is missing');
	return { asset, sidecar: sidecars[0], sidecarName };
}

export function validateMcplsCommit(commit: string): void {
	if (commit !== MCPLS.commit) throw new Error('mcpls tag commit mismatch');
}

export function validateSidecar(text: string): void {
	const hash = text.trim().split(/\s+/)[0];
	assertExactSha(hash, MCPLS.assetSha256, 'mcpls release sidecar');
}

type FetchRoute =
	| { readonly kind: 'general' }
	| { readonly kind: 'bound-release-asset'; readonly initialUrl: string };

function assertSafeHttps(url: URL): void {
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.port !== '' && url.port !== '443')
	)
		throw new Error(`unsafe HTTPS URL: ${url.origin}${url.pathname}`);
}

export function validateRedirect(
	current: URL,
	location: string,
	route: FetchRoute,
	status: number,
	hopIndex: number,
): { readonly next: URL; readonly ledger: RedirectHop } {
	if (hopIndex >= 5) throw new Error('redirect hop limit exceeded');
	const next = new URL(location, current);
	assertSafeHttps(next);
	if (route.kind !== 'bound-release-asset' || current.href !== route.initialUrl || hopIndex !== 0)
		throw new Error(`arbitrary redirect rejected from ${current.origin}${current.pathname}`);
	if (next.hostname !== 'release-assets.githubusercontent.com')
		throw new Error(`release asset redirect host rejected: ${next.hostname}`);
	return {
		next,
		ledger: {
			status,
			scheme: 'https:',
			host: next.hostname,
			path: next.pathname,
			queryPresent: next.search.length > 0,
			locationSha256: sha256Bytes(location),
		},
	};
}

async function allowedFetch(
	urlValue: string,
	accept = 'application/octet-stream',
	route: FetchRoute = { kind: 'general' },
): Promise<{ readonly response: Response; readonly hops: readonly RedirectHop[] }> {
	let current = assertAllowedUrl(urlValue);
	assertSafeHttps(current);
	if (route.kind === 'bound-release-asset' && route.initialUrl !== current.href)
		throw new Error('bound release route does not match initial URL');
	const hops: RedirectHop[] = [];
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		const response = await fetch(current, {
			redirect: 'manual',
			headers: { accept, 'user-agent': 'guessless-oracle-part-2-v1' },
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (location === null)
				throw new Error(`redirect from ${current.href} omitted Location`);
			const validated = validateRedirect(
				current,
				location,
				route,
				response.status,
				redirects,
			);
			hops.push(validated.ledger);
			current = validated.next;
			continue;
		}
		if (!response.ok) throw new Error(`HTTPS ${response.status} for ${current.href}`);
		return { response, hops };
	}
	throw new Error(`too many redirects for ${urlValue}`);
}

async function download(
	url: string,
	destination: string,
	route: FetchRoute = { kind: 'general' },
): Promise<{ readonly bytes: Uint8Array; readonly hops: readonly RedirectHop[] }> {
	const fetched = await allowedFetch(url, 'application/octet-stream', route);
	const bytes = new Uint8Array(await fetched.response.arrayBuffer());
	writeFileSync(destination, bytes, { flag: 'wx' });
	return { bytes, hops: fetched.hops };
}

async function getJson<T>(url: string): Promise<T> {
	const fetched = await allowedFetch(url, 'application/vnd.github+json');
	return (await fetched.response.json()) as T;
}

function extractArchive(archive: string, destination: string): string {
	mkdirSync(destination, { recursive: true });
	validateArchiveEntries(archive);
	const result = spawnSync('tar', ['-xzf', archive, '-C', destination], {
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (result.status !== 0)
		throw new Error(`tar extraction failed: ${result.stderr || result.stdout}`);
	const entries = readdirSync(destination).filter((entry) => entry !== '__MACOSX');
	if (entries.length !== 1)
		throw new Error(`archive must contain one root, found ${entries.length}`);
	const root = join(destination, entries[0]);
	if (!statSync(root).isDirectory()) throw new Error('archive root is not a directory');
	return root;
}

function validateArchiveEntries(archive: string): void {
	const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000 });
	if (listed.status !== 0) throw new Error(`tar listing failed: ${listed.stderr}`);
	for (const entry of listed.stdout.split('\n').filter(Boolean)) {
		if (entry.startsWith('/') || entry.split('/').includes('..'))
			throw new Error(`unsafe archive entry: ${entry}`);
	}
}

function extractAssetArchive(archive: string, destination: string): string {
	mkdirSync(destination, { recursive: true });
	validateArchiveEntries(archive);
	const result = spawnSync('tar', ['-xzf', archive, '-C', destination], {
		encoding: 'utf8',
		timeout: 120_000,
	});
	if (result.status !== 0)
		throw new Error(`mcpls asset extraction failed: ${result.stderr || result.stdout}`);
	return destination;
}

function walk(root: string, predicate: (path: string) => boolean): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && predicate(path)) found.push(path);
		}
	};
	visit(root);
	return found.sort();
}

function dependencyDirectories(root: string): string[] {
	return walk(root, () => false)
		.concat(findDirectories(root, new Set(['node_modules', '.pnpm', 'vendor'])))
		.map((path) => relative(root, path))
		.sort();
}

function findDirectories(root: string, names: ReadonlySet<string>): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(directory, entry.name);
			if (names.has(entry.name)) found.push(path);
			else if (entry.name !== '.git') visit(path);
		}
	};
	visit(root);
	return found;
}

function sourceFiles(root: string): string[] {
	return walk(root, (path) => /\.(?:[cm]?[jt]s|jsx|tsx)$/.test(path));
}

async function resolveTagCommit(tagName: string): Promise<string> {
	const ref = await getJson<{ object: { type: string; sha: string; url: string } }>(
		`https://api.github.com/repos/${MCPLS.owner}/${MCPLS.repository}/git/ref/tags/${encodeURIComponent(tagName)}`,
	);
	if (ref.object.type === 'commit') return ref.object.sha;
	if (ref.object.type !== 'tag')
		throw new Error(`unexpected mcpls tag object ${ref.object.type}`);
	const tag = await getJson<{ object: { type: string; sha: string } }>(ref.object.url);
	if (tag.object.type !== 'commit')
		throw new Error('mcpls annotated tag does not resolve to commit');
	return tag.object.sha;
}

function findBinary(root: string): string {
	const candidates = walk(root, (path) => basename(path) === 'mcpls');
	if (candidates.length !== 1)
		throw new Error(`mcpls asset must contain exactly one binary, found ${candidates.length}`);
	chmodSync(candidates[0], 0o755);
	return candidates[0];
}

function packageVersion(name: string): string {
	const packagePath = join(
		deriveOraclePaths().oraclePackage,
		'node_modules',
		name,
		'package.json',
	);
	const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
		name?: string;
		version?: string;
	};
	if (packageJson.name !== name || typeof packageJson.version !== 'string')
		throw new Error(`could not resolve package version for ${name}`);
	return packageJson.version;
}

function verifyExistingCache(cacheRoot: string, finalRoot: string): void {
	const finalStat = lstatSync(finalRoot);
	if (!finalStat.isDirectory() || finalStat.isSymbolicLink())
		throw new Error('existing cache final is not a real directory');
	assertContained(cacheRoot, finalRoot);
	const metadataPath = join(finalRoot, 'metadata.json');
	const metadataStat = lstatSync(metadataPath);
	if (!metadataStat.isFile() || metadataStat.isSymbolicLink())
		throw new Error('existing cache metadata is not a real file');
	const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CacheMetadata;
	if (
		metadata.evidenceId !== EVIDENCE_ID ||
		metadata.mcpls.tag !== MCPLS.tag ||
		metadata.mcpls.commit !== MCPLS.commit ||
		metadata.mcpls.assetId !== MCPLS.assetId ||
		metadata.mcpls.assetName !== MCPLS.assetName ||
		metadata.mcpls.assetSize !== MCPLS.assetSize ||
		metadata.mcpls.officialDigest !== `sha256:${MCPLS.assetSha256}` ||
		metadata.mcpls.actualSha256 !== MCPLS.assetSha256
	)
		throw new Error('existing cache immutable identity mismatch');
	const asset = join(finalRoot, 'mcpls', MCPLS.assetName);
	if (statSync(asset).size !== MCPLS.assetSize)
		throw new Error('existing cache asset size mismatch');
	assertExactSha(sha256File(asset), MCPLS.assetSha256, 'existing mcpls asset');
	for (const pin of REPOSITORIES) {
		const record = metadata.repositories.find((item) => item.id === pin.id);
		if (
			record === undefined ||
			record.commit !== pin.commit ||
			record.archiveSha256 !== pin.archiveSha256 ||
			record.licensePath !== pin.licensePath ||
			record.licenseSha256 !== pin.licenseSha256
		)
			throw new Error(`existing ${pin.id} identity mismatch`);
		assertExactSha(
			sha256File(join(finalRoot, 'archives', `${pin.id}.tar.gz`)),
			pin.archiveSha256,
			`existing ${pin.id} archive`,
		);
		assertExactSha(
			sha256File(join(finalRoot, record.sourceDir, pin.licensePath)),
			pin.licenseSha256,
			`existing ${pin.id} license`,
		);
	}
}

export function cleanupStage(cacheRoot: string, stage: string, stageName: string): void {
	assertSafeChildName(stageName);
	if (stage !== join(realpathSync(cacheRoot), stageName) || basename(stage) !== stageName)
		throw new Error('refusing unsafe staging cleanup');
	assertContained(cacheRoot, stage);
	const stat = lstatSync(stage);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error('staging cleanup target must be a real directory');
	rmSync(stage, { recursive: true, force: false });
}

export async function acquire(args: readonly string[]): Promise<void> {
	const evidenceIndex = args.indexOf('--evidence-id');
	assertNetworkConsent(
		args.includes('--allow-network'),
		evidenceIndex < 0 ? undefined : args[evidenceIndex + 1],
	);
	const cacheRoot = ensureCacheRoot();
	assertSafeChildName(EVIDENCE_ID);
	const finalRoot = join(cacheRoot, EVIDENCE_ID);
	if (existsSync(finalRoot)) {
		verifyExistingCache(cacheRoot, finalRoot);
		return;
	}
	const stageName = `.staging-${EVIDENCE_ID}-${process.pid}`;
	assertSafeChildName(stageName);
	const stage = join(cacheRoot, stageName);
	if (existsSync(stage)) throw new Error(`staging directory already exists: ${stage}`);
	mkdirSync(stage);
	assertContained(cacheRoot, stage);
	try {
		const repositories: CacheMetadata['repositories'][number][] = [];
		for (const pin of REPOSITORIES) {
			const archiveUrl = `https://codeload.github.com/${pin.owner}/${pin.repository}/tar.gz/${pin.commit}`;
			const archivePath = join(stage, 'archives', `${pin.id}.tar.gz`);
			mkdirSync(join(stage, 'archives'), { recursive: true });
			const downloaded = await download(archiveUrl, archivePath);
			assertExactSha(sha256Bytes(downloaded.bytes), pin.archiveSha256, `${pin.id} archive`);
			const unpacked = extractArchive(archivePath, join(stage, 'unpacked', pin.id));
			const sourceDir = join(stage, 'sources', pin.id);
			mkdirSync(join(stage, 'sources'), { recursive: true });
			renameSync(unpacked, sourceDir);
			const licensePath = join(sourceDir, pin.licensePath);
			if (!existsSync(licensePath)) throw new Error(`${pin.id} license path is missing`);
			assertExactSha(sha256File(licensePath), pin.licenseSha256, `${pin.id} license`);
			const dependencies = dependencyDirectories(sourceDir);
			if (dependencies.length > 0)
				throw new Error(
					`${pin.id} archive contains dependencies: ${dependencies.join(', ')}`,
				);
			repositories.push({
				...pin,
				archiveUrl,
				sourceDir: relative(stage, sourceDir),
				sourceFileCount: sourceFiles(sourceDir).length,
				dependencyDirectories: dependencies,
			});
		}

		const releaseUrl = `https://api.github.com/repos/${MCPLS.owner}/${MCPLS.repository}/releases/tags/${MCPLS.tag}`;
		const release = await getJson<GitHubRelease>(releaseUrl);
		const { asset, sidecar, sidecarName } = validateMcplsRelease(release);
		const assetPath = join(stage, 'mcpls', asset.name);
		mkdirSync(join(stage, 'mcpls'), { recursive: true });
		const assetDownload = await download(asset.browser_download_url, assetPath, {
			kind: 'bound-release-asset',
			initialUrl: asset.browser_download_url,
		});
		if (assetDownload.bytes.byteLength !== MCPLS.assetSize)
			throw new Error('mcpls asset size mismatch');
		const actualSha256 = sha256Bytes(assetDownload.bytes);
		assertExactSha(actualSha256, MCPLS.assetSha256, 'mcpls release asset');
		const sidecarPath = join(stage, 'mcpls', sidecar.name);
		const sidecarDownload = await download(sidecar.browser_download_url, sidecarPath, {
			kind: 'bound-release-asset',
			initialUrl: sidecar.browser_download_url,
		});
		const sidecarText = Buffer.from(sidecarDownload.bytes).toString('utf8');
		validateSidecar(sidecarText);
		const assetRoot = extractAssetArchive(assetPath, join(stage, 'mcpls', 'asset'));
		const binary = findBinary(assetRoot);

		const commit = await resolveTagCommit(MCPLS.tag);
		validateMcplsCommit(commit);
		const sourceArchive = join(stage, 'mcpls', 'source.tar.gz');
		await download(
			`https://codeload.github.com/${MCPLS.owner}/${MCPLS.repository}/tar.gz/${commit}`,
			sourceArchive,
		);
		const mcplsSource = extractArchive(sourceArchive, join(stage, 'mcpls', 'source'));
		const licensePaths = walk(mcplsSource, (path) =>
			/(?:^|\/)(?:LICENSE|COPYING|NOTICE)(?:[-.][^/]*)?$/i.test(path),
		);
		if (licensePaths.length < 2)
			throw new Error(
				`mcpls source exposes fewer than two license records (${licensePaths.length})`,
			);
		const licenses = licensePaths.map((path) => ({
			path: relative(mcplsSource, path),
			sha256: sha256File(path),
			text: readFileSync(path, 'utf8'),
		}));
		const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
		const parsedAssetUrl = parseURL(asset.browser_download_url);
		if (parsedAssetUrl.protocol !== 'https:') throw new Error('mcpls asset URL is not HTTPS');

		const metadata: CacheMetadata = {
			evidenceId: EVIDENCE_ID,
			acquiredAt: new Date(0).toISOString(),
			repositories,
			mcpls: {
				tag: MCPLS.tag,
				commit,
				assetId: asset.id,
				assetName: asset.name,
				assetSize: asset.size,
				assetUrl: asset.browser_download_url,
				officialDigest: `sha256:${MCPLS.assetSha256}`,
				actualSha256,
				binaryPath: relative(stage, binary),
				versionStdout: version.stdout,
				versionStderr: version.stderr,
				versionStatus: version.status,
				licenses,
				releaseJson: release,
				redirectHops: [...assetDownload.hops, ...sidecarDownload.hops],
				sidecarName,
				sidecarSha256Text: sidecarText,
			},
			tools: {
				node: process.version,
				pnpm: process.env.npm_config_user_agent ?? 'unknown',
				typescript: packageVersion('typescript') as '5.9.3',
				typescriptLanguageServer: packageVersion('typescript-language-server') as '5.3.0',
				pathe: packageVersion('pathe') as '2.0.3',
				ufo: packageVersion('ufo') as '1.6.4',
			},
		};
		if (
			metadata.tools.typescript !== '5.9.3' ||
			metadata.tools.typescriptLanguageServer !== '5.3.0' ||
			metadata.tools.pathe !== '2.0.3' ||
			metadata.tools.ufo !== '1.6.4'
		)
			throw new Error('oracle tool version pin mismatch');
		writeFileSync(join(stage, 'metadata.json'), stableJson(metadata), { flag: 'wx' });
		if (existsSync(finalRoot)) throw new Error(`refusing to overwrite cache ${finalRoot}`);
		assertContained(cacheRoot, stage);
		if (basename(stage) !== stageName) throw new Error('staging basename changed');
		renameSync(stage, finalRoot);
		assertContained(cacheRoot, finalRoot);
	} catch (error) {
		if (existsSync(stage)) cleanupStage(cacheRoot, stage, stageName);
		throw error;
	}
}
