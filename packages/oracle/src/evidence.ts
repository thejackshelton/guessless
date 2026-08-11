import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	cpSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStage, validateMcplsRelease, validateRedirect } from './acquire.ts';
import {
	recordGuessless,
	runNonbuild,
	validateNonbuildEvidence,
	type GuesslessEvidence,
	type NonbuildEvidence,
} from './corpus.ts';
import {
	assertContained,
	assertExactSha,
	assertOffline,
	assertSafeChildName,
	deriveOraclePaths,
	ensureCacheRoot,
	ensureRealDirectory,
	EVIDENCE_ID,
	exactEvidencePath,
	MCPLS,
	PERFORMANCE_LINES,
	REPOSITORIES,
	sha256Bytes,
	sha256File,
	stableJson,
	type CacheMetadata,
	type EvidenceManifest,
	type ManifestEntry,
} from './contracts.ts';
import { hasNonEmptyContent, recordMcpls, type McplsEvidence } from './lsp.ts';
import {
	generateSource,
	percentile,
	QUERY_KINDS,
	recordPerformance,
	serializePerformanceRecord,
	type PerformanceProcessEvidence,
} from './performance.ts';

const enginePackage: string = '@guessless/engine';
const { verifyReceipt } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

const RAW_FILES = [
	'acquisition.jsonl',
	'mcpls-release.json',
	'performance.jsonl',
	'calibration.jsonl',
	'react-boilerplate-v4.nonbuild.stdout.txt',
	'react-boilerplate-v4.nonbuild.stderr.txt',
	'react-boilerplate-v4.guessless.jsonl',
	'react-boilerplate-v4.mcpls.stdout.jsonl',
	'react-boilerplate-v4.mcpls.stderr.txt',
	'react-realworld-cra1.nonbuild.stdout.txt',
	'react-realworld-cra1.nonbuild.stderr.txt',
	'react-realworld-cra1.guessless.jsonl',
	'react-realworld-cra1.mcpls.stdout.jsonl',
	'react-realworld-cra1.mcpls.stderr.txt',
	'angular-phonecat.nonbuild.stdout.txt',
	'angular-phonecat.nonbuild.stderr.txt',
	'angular-phonecat.guessless.jsonl',
	'angular-phonecat.mcpls.stdout.jsonl',
	'angular-phonecat.mcpls.stderr.txt',
] as const;

const CHECKED_FILES = ['commands.json', 'summary.md', ...RAW_FILES.map((path) => `raw/${path}`)];

function assertRealDirectory(path: string, label: string): string {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${label} must be a real directory`);
	return realpathSync(path);
}

function assertRealFile(path: string, label: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
}

function cacheFinal(): {
	readonly root: string;
	readonly final: string;
	readonly metadata: CacheMetadata;
} {
	const root = ensureCacheRoot();
	assertSafeChildName(EVIDENCE_ID);
	const final = join(root, EVIDENCE_ID);
	assertRealDirectory(final, 'oracle cache evidence');
	assertContained(root, final);
	const metadataPath = join(final, 'metadata.json');
	assertRealFile(metadataPath, 'cache metadata');
	const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CacheMetadata;
	return { root, final, metadata };
}

function walkDirectories(root: string, names: ReadonlySet<string>): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(directory, entry.name);
			if (names.has(entry.name)) found.push(path);
			else visit(path);
		}
	};
	visit(root);
	return found;
}

function verifyCache(): ReturnType<typeof cacheFinal> {
	const cached = cacheFinal();
	if (cached.metadata.evidenceId !== EVIDENCE_ID) throw new Error('cache evidence ID mismatch');
	if (cached.metadata.repositories.length !== REPOSITORIES.length)
		throw new Error('cache repository count mismatch');
	for (const pin of REPOSITORIES) {
		const record = cached.metadata.repositories.find((item) => item.id === pin.id);
		if (record === undefined || stableJson({ ...record, sourceDir: undefined }) === '')
			throw new Error(`${pin.id} cache metadata missing`);
		for (const key of [
			'owner',
			'repository',
			'commit',
			'archiveSha256',
			'licensePath',
			'licenseSha256',
		] as const)
			if (record[key] !== pin[key]) throw new Error(`${pin.id} ${key} pin mismatch`);
		const archive = join(cached.final, 'archives', `${pin.id}.tar.gz`);
		assertRealFile(archive, `${pin.id} archive`);
		assertExactSha(sha256File(archive), pin.archiveSha256, `${pin.id} archive`);
		const source = join(cached.final, record.sourceDir);
		assertRealDirectory(source, `${pin.id} source`);
		assertContained(cached.final, source);
		const license = join(source, pin.licensePath);
		assertRealFile(license, `${pin.id} license`);
		assertExactSha(sha256File(license), pin.licenseSha256, `${pin.id} license`);
		const dependencies = walkDirectories(source, new Set(['node_modules', '.pnpm', 'vendor']));
		if (dependencies.length > 0 || record.dependencyDirectories.length > 0)
			throw new Error(`${pin.id} dependency absence proof failed`);
	}
	const mcpls = cached.metadata.mcpls;
	if (
		mcpls.tag !== MCPLS.tag ||
		mcpls.commit !== MCPLS.commit ||
		mcpls.assetId !== MCPLS.assetId ||
		mcpls.assetName !== MCPLS.assetName ||
		mcpls.assetSize !== MCPLS.assetSize ||
		mcpls.officialDigest !== `sha256:${MCPLS.assetSha256}` ||
		mcpls.actualSha256 !== MCPLS.assetSha256 ||
		mcpls.sidecarSha256Text.trim().split(/\s+/)[0] !== MCPLS.assetSha256 ||
		mcpls.versionStdout !== 'mcpls 0.3.5\n' ||
		mcpls.versionStatus !== 0 ||
		mcpls.licenses.length < 2
	)
		throw new Error('mcpls cache identity mismatch');
	const asset = join(cached.final, 'mcpls', MCPLS.assetName);
	assertRealFile(asset, 'mcpls asset');
	if (statSync(asset).size !== MCPLS.assetSize) throw new Error('cached mcpls size mismatch');
	assertExactSha(sha256File(asset), MCPLS.assetSha256, 'cached mcpls asset');
	for (const hop of mcpls.redirectHops) {
		if (
			hop.scheme !== 'https:' ||
			hop.host !== 'release-assets.githubusercontent.com' ||
			!hop.path.startsWith('/github-production-release-asset/') ||
			!/^[a-f0-9]{64}$/.test(hop.locationSha256)
		)
			throw new Error('sanitized redirect ledger mismatch');
		if (JSON.stringify(hop).includes('?'))
			throw new Error('signed redirect query was persisted');
	}
	if (
		cached.metadata.tools.typescript !== '5.9.3' ||
		cached.metadata.tools.typescriptLanguageServer !== '5.3.0' ||
		cached.metadata.tools.pathe !== '2.0.3' ||
		cached.metadata.tools.ufo !== '1.6.4'
	)
		throw new Error('oracle tool version mismatch');
	return cached;
}

function jsonLines(values: readonly unknown[]): string {
	return values.map((value) => stableJson(value).trimEnd()).join('\n') + '\n';
}

function writeNew(path: string, contents: string): void {
	writeFileSync(path, contents, { flag: 'wx' });
}

function census(records: readonly GuesslessEvidence[]): {
	readonly states: Record<string, number>;
	readonly unresolvedReasons: Record<string, number>;
} {
	const states: Record<string, number> = {};
	const unresolvedReasons: Record<string, number> = {};
	for (const record of records) {
		states[record.receipt.state] = (states[record.receipt.state] ?? 0) + 1;
		if (record.receipt.state === 'partial')
			for (const gap of record.receipt.unresolved)
				unresolvedReasons[gap.reason] = (unresolvedReasons[gap.reason] ?? 0) + 1;
		if (record.receipt.state === 'refused')
			unresolvedReasons[record.receipt.reason] =
				(unresolvedReasons[record.receipt.reason] ?? 0) + 1;
	}
	return { states, unresolvedReasons };
}

function validateGuessless(records: readonly GuesslessEvidence[], repository: string): void {
	if (records.length < 2) throw new Error(`${repository} lacks two Guessless receipts`);
	if (!records.some((record) => record.query === 'definitionOf'))
		throw new Error(`${repository} lacks definition receipt`);
	if (!records.some((record) => record.query === 'referencesOf'))
		throw new Error(`${repository} lacks references receipt`);
	for (const record of records) {
		if (
			record.repository !== repository ||
			record.receipt.results.length === 0 ||
			!record.integrityValid ||
			!record.replayCanonical ||
			!verifyReceipt(record.receipt) ||
			record.citations.some((citation) => !citation.resolved)
		)
			throw new Error(`${repository} Guessless semantic evidence failed`);
	}
}

export function validatePerformance(
	records: readonly PerformanceProcessEvidence[],
	cliPath?: string,
): void {
	if (records.length !== PERFORMANCE_LINES.length)
		throw new Error('performance scale count mismatch');
	for (const lines of PERFORMANCE_LINES) {
		const item = records.find((record) => record.lines === lines);
		if (
			item?.status !== 0 ||
			item.signal !== null ||
			item.stderr !== '' ||
			item.record === undefined
		)
			throw new Error(
				`performance scale ${lines} did not complete; raw failure must be retained`,
			);
		if (
			item.record.lines !== lines ||
			item.record.files !== 1 ||
			item.record.bytes !== Buffer.byteLength(generateSource(lines)) ||
			!item.record.physicalLinesVerified ||
			item.record.coldTrials.length !== 3 ||
			item.record.sourceSha256 !== sha256Bytes(generateSource(lines)) ||
			item.timeoutMs !== (lines === 1_000_000 ? 1_200_000 : 300_000) ||
			item.maxOldSpaceMiB !== (lines === 1_000_000 ? 8192 : 4096) ||
			item.record.process.timeoutMs !== item.timeoutMs ||
			item.record.process.maxOldSpaceMiB !== item.maxOldSpaceMiB
		)
			throw new Error(`performance scale ${lines} semantic mismatch`);
		const expectedCommand = [
			process.execPath,
			`--max-old-space-size=${item.maxOldSpaceMiB}`,
			cliPath ?? item.command[2],
			'performance-worker',
			String(lines),
		];
		if (stableJson(item.command) !== stableJson(expectedCommand))
			throw new Error(`performance scale ${lines} command mismatch`);
		if (item.stdout !== serializePerformanceRecord(item.record))
			throw new Error(`performance scale ${lines} captured stdout mismatch`);
		for (const trial of item.record.coldTrials) {
			const add = BigInt(trial.addFileNs);
			const link = BigInt(trial.linkNs);
			const total = BigInt(trial.totalNs);
			if (trial.addFileState !== 'accepted' || add <= 0n || link <= 0n || total < add + link)
				throw new Error(`performance scale ${lines} cold trial mismatch`);
		}
		if (
			stableJson(Object.keys(item.record.queries).sort()) !==
			stableJson([...QUERY_KINDS].sort())
		)
			throw new Error(`performance scale ${lines} query-key mismatch`);
		for (const kind of QUERY_KINDS) {
			const query = item.record.queries[kind];
			if (
				query.rawNs.length !== 30 ||
				query.receiptStates.length !== 30 ||
				query.receiptStates.some(
					(state) => !['complete', 'partial', 'refused'].includes(state),
				)
			)
				throw new Error(`performance scale ${lines} raw query samples missing`);
			const raw = query.rawNs.map(BigInt);
			if (raw.some((value) => value <= 0n))
				throw new Error(`performance scale ${lines} non-positive query sample`);
			if (
				query.p50Ns !== String(percentile(raw, 0.5)) ||
				query.p95Ns !== String(percentile(raw, 0.95))
			)
				throw new Error(`performance scale ${lines} percentile mismatch`);
		}
	}
}

function parseJsonLines<T>(path: string): T[] {
	assertRealFile(path, `evidence ${path}`);
	const text = readFileSync(path, 'utf8');
	if (!text.endsWith('\n')) throw new Error(`${path} must end in newline`);
	return text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as T);
}

export function validateLspEvidence(
	lsp: McplsEvidence,
	repository: string,
	workspace: string,
	expectedPosition: GuesslessEvidence['comparisonPosition'],
	rawStderr: string,
): void {
	if (
		lsp.repository !== repository ||
		lsp.workspace !== workspace ||
		stableJson(lsp.position) !== stableJson(expectedPosition) ||
		lsp.stderr !== rawStderr ||
		lsp.honestLimitation.length === 0
	)
		throw new Error(`${repository} LSP identity mismatch`);
	const frames = lsp.transcript.map((frame) => ({
		...frame,
		value: JSON.parse(frame.raw) as Record<string, unknown>,
	}));
	if (
		frames.length !== 9 ||
		frames.some((frame) => !['stdin', 'stdout'].includes(frame.direction))
	)
		throw new Error(`${repository} LSP transcript shape mismatch`);
	const request = (id: number): Record<string, unknown> => {
		const frame = frames.find((item) => item.direction === 'stdin' && item.value.id === id);
		if (frame === undefined) throw new Error(`${repository} LSP request ${id} missing`);
		return frame.value;
	};
	const response = (id: number): Record<string, unknown> => {
		const frame = frames.find((item) => item.direction === 'stdout' && item.value.id === id);
		if (frame === undefined) throw new Error(`${repository} LSP response ${id} missing`);
		return frame.value;
	};
	const initialize = request(1);
	const initialized = frames.find(
		(item) => item.direction === 'stdin' && item.value.method === 'notifications/initialized',
	);
	const initializeResult = response(1).result as Record<string, unknown> | undefined;
	const serverInfo = initializeResult?.serverInfo as Record<string, unknown> | undefined;
	if (
		initialize.method !== 'initialize' ||
		(initialize.params as Record<string, unknown>)?.protocolVersion !== '2024-11-05' ||
		initializeResult?.protocolVersion !== '2024-11-05' ||
		serverInfo?.name !== 'mcpls' ||
		initialized === undefined
	)
		throw new Error(`${repository} LSP initialize identity mismatch`);
	const absoluteFile = join(workspace, expectedPosition.file);
	for (const [id, name] of [
		[2, 'get_definition'],
		[3, 'get_references'],
		[4, 'get_diagnostics'],
	] as const) {
		const frame = request(id);
		const params = frame.params as Record<string, unknown>;
		const args = params.arguments as Record<string, unknown>;
		if (
			frame.method !== 'tools/call' ||
			params.name !== name ||
			args.file_path !== absoluteFile ||
			(id !== 4 &&
				(args.line !== expectedPosition.line ||
					args.character !== expectedPosition.character))
		)
			throw new Error(`${repository} LSP tool request mismatch`);
	}
	if (
		stableJson(response(2).result) !== stableJson(lsp.definition) ||
		stableJson(response(3).result) !== stableJson(lsp.references)
	)
		throw new Error(`${repository} LSP transcript result mismatch`);
	const diagnosticResponse = response(4);
	const expectedDiagnostics =
		diagnosticResponse.error === undefined
			? diagnosticResponse.result
			: { error: `mcpls tools/call: ${JSON.stringify(diagnosticResponse.error)}` };
	if (stableJson(expectedDiagnostics) !== stableJson(lsp.diagnostics))
		throw new Error(`${repository} LSP diagnostic transcript mismatch`);
	const computedSuccess =
		hasNonEmptyContent(lsp.definition) || hasNonEmptyContent(lsp.references);
	if (!computedSuccess || lsp.usefulSuccess !== computedSuccess)
		throw new Error(`${repository} LSP useful-success mismatch`);
	const diagnosticText = JSON.stringify(lsp.diagnostics);
	if (!lsp.honestLimitation.includes(diagnosticText))
		throw new Error(`${repository} LSP diagnostic limitation mismatch`);
}

interface CommandsEvidence {
	readonly evidenceId: string;
	readonly supersededManifestSha256: string;
	readonly nonbuild: readonly Omit<NonbuildEvidence, 'stdout' | 'stderr'>[];
	readonly mcpls: readonly {
		readonly repository: string;
		readonly command: readonly string[];
		readonly position: GuesslessEvidence['comparisonPosition'];
	}[];
	readonly performance: readonly {
		readonly lines: number;
		readonly command: readonly string[];
		readonly timeoutMs: number;
		readonly maxOldSpaceMiB: number;
	}[];
}

interface CalibrationRecord {
	readonly guard: string;
	readonly mutation: string;
	readonly expectedRed: boolean;
	readonly restorationByteIdentical: boolean;
	readonly evidence: string;
}

function checkedBundleHash(evidenceRoot: string, cached: ReturnType<typeof cacheFinal>): string {
	const chunks: Buffer[] = [];
	for (const path of [...CHECKED_FILES, 'manifest.json'].sort()) {
		chunks.push(Buffer.from(`${path}\0`));
		chunks.push(readFileSync(join(evidenceRoot, path)));
	}
	for (const path of [
		'metadata.json',
		...REPOSITORIES.flatMap((repository) => [
			`archives/${repository.id}.tar.gz`,
			`${cached.metadata.repositories.find((item) => item.id === repository.id)?.sourceDir}/${repository.licensePath}`,
		]),
		`mcpls/${MCPLS.assetName}`,
	]) {
		chunks.push(Buffer.from(`${path}\0`));
		chunks.push(readFileSync(join(cached.final, path)));
	}
	return sha256Bytes(Buffer.concat(chunks));
}

function calibrations(
	evidenceRoot: string,
	cached: ReturnType<typeof cacheFinal>,
): CalibrationRecord[] {
	const records: CalibrationRecord[] = [];
	const check = (guard: string, mutation: string, action: () => void): void => {
		const before = checkedBundleHash(evidenceRoot, cached);
		let rejection = '';
		try {
			action();
		} catch (error) {
			rejection = error instanceof Error ? error.message : String(error);
		}
		const after = checkedBundleHash(evidenceRoot, cached);
		records.push({
			guard,
			mutation,
			expectedRed: rejection.length > 0,
			restorationByteIdentical: before === after,
			evidence: rejection,
		});
	};
	const semantic = (
		guard: string,
		mutation: string,
		mutate: (copy: string) => void,
		staleManifest = false,
	): void =>
		check(guard, mutation, () => {
			const temp = mkdtempSync(join(tmpdir(), `guessless-calibration-${guard}-`));
			try {
				const copy = join(temp, EVIDENCE_ID);
				cpSync(evidenceRoot, copy, { recursive: true, errorOnExist: true });
				mutate(copy);
				if (!staleManifest)
					writeFileSync(join(copy, 'manifest.json'), stableJson(manifestFor(copy)));
				verifySemanticEvidence(
					copy,
					cached,
					join(deriveOraclePaths().oraclePackage, 'dist/cli.js'),
				);
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		});
	const mutateJsonLine = (copy: string, name: string, mutate: (value: any) => void): void => {
		const path = join(copy, 'raw', name);
		const values = parseJsonLines<any>(path);
		mutate(values[0]);
		writeFileSync(path, jsonLines(values));
	};
	semantic('receipt-integrity', 'replace receipt integrity with zeros', (copy) =>
		mutateJsonLine(copy, `${REPOSITORIES[0].id}.guessless.jsonl`, (value) => {
			value.receipt.integrity = '0'.repeat(64);
		}),
	);
	semantic('nonbuild-command', 'restore invalid pnpm global --offline', (copy) => {
		const path = join(copy, 'commands.json');
		const value = JSON.parse(readFileSync(path, 'utf8')) as any;
		value.nonbuild[0].command.splice(
			value.nonbuild[0].command.lastIndexOf('run'),
			0,
			'--offline',
		);
		writeFileSync(path, stableJson(value));
	});
	semantic('lsp-success', 'flip computed useful success false', (copy) =>
		mutateJsonLine(copy, `${REPOSITORIES[0].id}.mcpls.stdout.jsonl`, (value) => {
			value.usefulSuccess = false;
		}),
	);
	semantic('lsp-transcript', 'replace definition transcript result', (copy) =>
		mutateJsonLine(copy, `${REPOSITORIES[0].id}.mcpls.stdout.jsonl`, (value) => {
			const frame = value.transcript.find(
				(item: any) => item.direction === 'stdout' && JSON.parse(item.raw).id === 2,
			);
			frame.raw = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } });
		}),
	);
	semantic('exact-line-count', 'increment recorded physical line count', (copy) =>
		mutateJsonLine(copy, 'performance.jsonl', (value) => {
			value.record.lines += 1;
		}),
	);
	semantic('percentile', 'replace p50 with non-recomputed value', (copy) =>
		mutateJsonLine(copy, 'performance.jsonl', (value) => {
			value.record.queries.definitionOf.p50Ns = '1';
			value.stdout = serializePerformanceRecord(value.record);
		}),
	);
	semantic('raw-query-samples', 'remove one raw query sample', (copy) =>
		mutateJsonLine(copy, 'performance.jsonl', (value) => {
			value.record.queries.definitionOf.rawNs.pop();
			value.stdout = serializePerformanceRecord(value.record);
		}),
	);
	semantic('performance-stdout', 'append one byte to captured performance stdout', (copy) =>
		mutateJsonLine(copy, 'performance.jsonl', (value) => {
			value.stdout += ' ';
		}),
	);
	semantic('census', 'replace recomputed receipt-state census', (copy) => {
		const path = join(copy, 'summary.md');
		writeFileSync(
			path,
			readFileSync(path, 'utf8').replace(
				/Receipt-state census: `[^`]+`\./,
				'Receipt-state census: `{}`.',
			),
		);
	});
	semantic('semantic-command', 'change a recorded performance cap', (copy) => {
		const path = join(copy, 'commands.json');
		const value = JSON.parse(readFileSync(path, 'utf8')) as any;
		value.performance[0].timeoutMs += 1;
		writeFileSync(path, stableJson(value));
	});
	semantic(
		'evidence-sha256',
		'append a byte while leaving manifest stale',
		(copy) => {
			const path = join(copy, 'summary.md');
			writeFileSync(path, `${readFileSync(path, 'utf8')}x`);
		},
		true,
	);
	const archive = readFileSync(join(cached.final, 'archives', `${REPOSITORIES[0].id}.tar.gz`));
	const archiveMutation = Buffer.from(archive);
	archiveMutation[0] ^= 1;
	check('archive-sha256', 'flip one archive byte', () =>
		assertExactSha(
			sha256Bytes(archiveMutation),
			REPOSITORIES[0].archiveSha256,
			'archive calibration',
		),
	);
	const source = join(cached.final, cached.metadata.repositories[0].sourceDir);
	const license = readFileSync(join(source, REPOSITORIES[0].licensePath));
	const licenseMutation = Buffer.concat([license, Buffer.from('x')]);
	check('license-sha256', 'append one license byte', () =>
		assertExactSha(
			sha256Bytes(licenseMutation),
			REPOSITORIES[0].licenseSha256,
			'license calibration',
		),
	);
	const initial = new URL(
		`https://github.com/bug-ops/mcpls/releases/download/${MCPLS.tag}/${MCPLS.assetName}`,
	);
	check('redirect-route', 'replace exact redirect host with a subdomain', () => {
		validateRedirect(
			initial,
			'https://evil.release-assets.githubusercontent.com/object',
			{ kind: 'bound-release-asset', initialUrl: initial.href },
			302,
			0,
		);
	});
	check('asset-identity', 'increment release asset size', () => {
		validateMcplsRelease({
			tag_name: MCPLS.tag,
			assets: [
				{
					id: MCPLS.assetId,
					name: MCPLS.assetName,
					size: MCPLS.assetSize + 1,
					content_type: MCPLS.assetContentType,
					browser_download_url: initial.href,
					digest: `sha256:${MCPLS.assetSha256}`,
				},
			],
		});
	});
	check('cache-containment', 'replace cache child with dot-dot escape', () => {
		assertSafeChildName('../escape');
	});
	const temp = mkdtempSync(join(tmpdir(), 'guessless-calibration-'));
	try {
		const cache = join(temp, 'oracle');
		mkdirSync(cache);
		const sentinel = join(cache, 'sentinel');
		writeFileSync(sentinel, 'unchanged');
		const stageName = `.staging-${EVIDENCE_ID}-1`;
		const target = join(temp, 'target');
		mkdirSync(target);
		symlinkSync(target, join(cache, stageName));
		check('cleanup-symlink-sentinel', 'replace exact stage with symlink', () => {
			cleanupStage(realpathSync(cache), join(realpathSync(cache), stageName), stageName);
		});
		if (readFileSync(sentinel, 'utf8') !== 'unchanged')
			throw new Error('cleanup calibration changed unrelated sentinel');
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	if (records.some((record) => !record.expectedRed || !record.restorationByteIdentical))
		throw new Error('expected-red calibration failed');
	return records;
}

function manifestFor(evidenceRoot: string): EvidenceManifest {
	const files: ManifestEntry[] = CHECKED_FILES.sort().map((path) => {
		const absolute = join(evidenceRoot, path);
		assertRealFile(absolute, `evidence ${path}`);
		return { path, bytes: statSync(absolute).size, sha256: sha256File(absolute) };
	});
	return { schema: 'guessless.oracle-evidence/v1', evidenceId: EVIDENCE_ID, files };
}

function verifyManifest(evidenceRoot: string): EvidenceManifest {
	const manifestPath = join(evidenceRoot, 'manifest.json');
	assertRealFile(manifestPath, 'evidence manifest');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
	if (manifest.schema !== 'guessless.oracle-evidence/v1' || manifest.evidenceId !== EVIDENCE_ID)
		throw new Error('evidence manifest identity mismatch');
	if (stableJson(manifest) !== stableJson(manifestFor(evidenceRoot)))
		throw new Error('evidence manifest file set/hash mismatch');
	return manifest;
}

function sourceRoot(cached: ReturnType<typeof cacheFinal>, repository: string): string {
	const record = cached.metadata.repositories.find((item) => item.id === repository);
	if (record === undefined) throw new Error(`cache repository missing: ${repository}`);
	const source = join(cached.final, record.sourceDir);
	assertRealDirectory(source, `${repository} source`);
	assertContained(cached.final, source);
	return source;
}

const CLOSED_PREDECESSOR_MANIFEST_SHA256 =
	'f891b559c2218596e0fa84f4429d0ef04575b3dcc261fc64dd369130bdf71eec';
const REPAIRABLE_MANIFEST_SHA256 =
	'f43d73071cbe46a581039135cc8df29a6f8ce198df42193c3be82057571b61e9';
const VALID_SUPERSEDED_MANIFESTS = new Set([
	CLOSED_PREDECESSOR_MANIFEST_SHA256,
	REPAIRABLE_MANIFEST_SHA256,
]);

export function promoteDirectoryWithRollback(
	parent: string,
	stage: string,
	final: string,
	backupName: string,
	verify: () => void,
): void {
	const parentReal = assertRealDirectory(parent, 'promotion parent');
	assertRealDirectory(stage, 'promotion stage');
	assertRealDirectory(final, 'promotion final');
	assertContained(parentReal, stage);
	assertContained(parentReal, final);
	assertSafeChildName(backupName);
	const backup = join(parentReal, backupName);
	if (existsSync(backup)) throw new Error('repair backup already exists');
	renameSync(final, backup);
	try {
		renameSync(stage, final);
		verify();
		rmSync(backup, { recursive: true });
	} catch (error) {
		if (existsSync(final)) renameSync(final, stage);
		if (existsSync(backup)) renameSync(backup, final);
		throw error;
	}
}

async function generateAndPromoteEvidence(
	args: readonly string[],
	cliPath: string,
	mode: 'record' | 'repair',
): Promise<void> {
	assertOffline();
	if (!args.includes('--offline')) throw new Error(`${mode} requires --offline`);
	const evidenceArgument = args[args.indexOf('--evidence-dir') + 1];
	const paths = deriveOraclePaths();
	const finalEvidence = exactEvidencePath(evidenceArgument, paths);
	const cached = verifyCache();
	let supersededManifestSha256: string | undefined;
	if (mode === 'record' && existsSync(finalEvidence))
		throw new Error('record refuses to overwrite sealed evidence');
	if (mode === 'repair') {
		if (!existsSync(finalEvidence)) throw new Error('repair requires sealed evidence');
		const expected = args[args.indexOf('--expected-manifest-sha256') + 1];
		if (expected !== REPAIRABLE_MANIFEST_SHA256)
			throw new Error('repair manifest precondition is not the one authorized hash');
		const actual = sha256File(join(finalEvidence, 'manifest.json'));
		if (actual !== expected) throw new Error('repair manifest SHA-256 precondition mismatch');
		verifyManifest(finalEvidence);
		supersededManifestSha256 = actual;
	}
	const docs = assertRealDirectory(join(paths.root, 'docs'), 'docs root');
	const evidenceParent = ensureRealDirectory(docs, 'evidence');
	const stageName = `.staging-${EVIDENCE_ID}-${process.pid}`;
	assertSafeChildName(stageName);
	const stage = join(evidenceParent, stageName);
	if (existsSync(stage)) throw new Error(`evidence staging exists: ${stage}`);
	mkdirSync(stage);
	assertContained(evidenceParent, stage);
	const raw = ensureRealDirectory(stage, 'raw');
	try {
		const acquisitionRecords = [
			...cached.metadata.repositories.map((repository) => ({
				type: 'repository',
				...repository,
			})),
			{ type: 'tools', ...cached.metadata.tools },
			{
				type: 'mcpls',
				tag: cached.metadata.mcpls.tag,
				commit: cached.metadata.mcpls.commit,
				assetId: cached.metadata.mcpls.assetId,
				assetName: cached.metadata.mcpls.assetName,
				assetSize: cached.metadata.mcpls.assetSize,
				officialDigest: cached.metadata.mcpls.officialDigest,
				actualSha256: cached.metadata.mcpls.actualSha256,
				redirectHops: cached.metadata.mcpls.redirectHops,
			},
		];
		writeNew(join(raw, 'acquisition.jsonl'), jsonLines(acquisitionRecords));
		writeNew(join(raw, 'mcpls-release.json'), stableJson(cached.metadata.mcpls));

		const allGuessless: GuesslessEvidence[] = [];
		const allLsp: McplsEvidence[] = [];
		const nonbuild: NonbuildEvidence[] = [];
		const mcplsBinary = join(cached.final, cached.metadata.mcpls.binaryPath);
		assertRealFile(mcplsBinary, 'mcpls binary');
		const tls = join(paths.oraclePackage, 'node_modules/.bin/typescript-language-server');
		if (!existsSync(tls)) throw new Error('typescript-language-server executable missing');
		for (const repository of REPOSITORIES) {
			const source = sourceRoot(cached, repository.id);
			const diagnostic = runNonbuild(repository.id, source);
			nonbuild.push(diagnostic);
			writeNew(join(raw, `${repository.id}.nonbuild.stdout.txt`), diagnostic.stdout);
			writeNew(join(raw, `${repository.id}.nonbuild.stderr.txt`), diagnostic.stderr);
			const guessless = recordGuessless(repository.id, source);
			validateGuessless(guessless, repository.id);
			allGuessless.push(...guessless);
			writeNew(join(raw, `${repository.id}.guessless.jsonl`), jsonLines(guessless));
			const definition = guessless.find((record) => record.query === 'definitionOf');
			if (definition === undefined)
				throw new Error(`${repository.id} definition target missing`);
			let lsp: McplsEvidence;
			try {
				lsp = await recordMcpls(
					repository.id,
					source,
					definition.comparisonPosition,
					mcplsBinary,
					tls,
				);
			} catch (error) {
				throw new Error(
					`${repository.id} mcpls failed at ${JSON.stringify(definition.comparisonPosition)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			allLsp.push(lsp);
			writeNew(join(raw, `${repository.id}.mcpls.stdout.jsonl`), jsonLines([lsp]));
			writeNew(join(raw, `${repository.id}.mcpls.stderr.txt`), lsp.stderr);
		}
		if (!allLsp.some((item) => item.usefulSuccess))
			throw new Error('mcpls produced no useful non-empty success');
		if (!allLsp.some((item) => item.honestLimitation.length > 0))
			throw new Error('mcpls evidence lacks an honest limitation');

		const performance = recordPerformance(cliPath);
		writeNew(join(raw, 'performance.jsonl'), jsonLines(performance));
		validatePerformance(performance);
		const stateCensus = census(allGuessless);
		const commands = {
			evidenceId: EVIDENCE_ID,
			supersededManifestSha256: supersededManifestSha256 ?? 'none',
			nonbuild: nonbuild.map((item) => ({
				...item,
				stdout: undefined,
				stderr: undefined,
			})),
			mcpls: allLsp.map((item) => ({
				repository: item.repository,
				command: item.command,
				position: item.position,
			})),
			performance: performance.map((item) => ({
				lines: item.lines,
				command: item.command,
				timeoutMs: item.timeoutMs,
				maxOldSpaceMiB: item.maxOldSpaceMiB,
			})),
		};
		writeNew(join(stage, 'commands.json'), stableJson(commands));
		const summary = [
			'# Guessless oracle part 2',
			'',
			`Evidence ID: \`${EVIDENCE_ID}\`.`,
			`Superseded manifest SHA-256: \`${supersededManifestSha256 ?? 'none'}\`.`,
			'',
			'Three pinned licensed repositories were indexed from verified clean archives without installed dependencies. Receipts are useful, integrity-valid, canonically replayable, and retain complete/partial/refused states without claiming unknown ground truth.',
			'',
			`Receipt-state census: \`${JSON.stringify(stateCensus.states)}\`.`,
			`Named unresolved-reason census: \`${JSON.stringify(stateCensus.unresolvedReasons)}\`.`,
			'',
			`mcpls/typescript-language-server produced ${allLsp.filter((item) => item.usefulSuccess).length} useful repository comparisons. LSP performs well at editor-style definition/reference lookup when its project model initializes; exact diagnostics and limitations are retained verbatim and are not treated as ground truth.`,
			'',
			'Performance records contain exact 10k, 100k, and 1M physical-line inputs, three cold trials, one query warmup, 30 raw samples for all nine queries, p50/p95, hashes, process caps, and machine/tool metadata.',
			'',
			...performance.flatMap((item) =>
				item.record === undefined
					? []
					: [
							`${item.lines} lines cold total (ns): ${item.record.coldTrials.map((trial) => trial.totalNs).join(', ')}.`,
							`${item.lines} lines query p50/p95 (ns): ${QUERY_KINDS.map((kind) => `${kind}=${item.record?.queries[kind].p50Ns}/${item.record?.queries[kind].p95Ns}`).join(', ')}.`,
						],
			),
			'',
			`Repository index sizes (files/bytes): ${REPOSITORIES.map((repository) => {
				const first = allGuessless.find((item) => item.repository === repository.id);
				return `${repository.id}=${first?.indexedFiles}/${first?.indexedBytes}`;
			}).join(', ')}.`,
			'The synthetic workload is one TypeScript file with nine fixed code lines plus comment padding. It measures physical-line scaling, not real-project complexity.',
			'',
		].join('\n');
		writeNew(join(stage, 'summary.md'), summary);
		writeNew(
			join(raw, 'calibration.jsonl'),
			jsonLines([
				{
					guard: 'bootstrap',
					mutation: 'none',
					expectedRed: true,
					restorationByteIdentical: true,
					evidence: 'bootstrap',
				},
			]),
		);
		writeNew(join(stage, 'manifest.json'), stableJson(manifestFor(stage)));
		const calibration = calibrations(stage, cached);
		writeFileSync(join(raw, 'calibration.jsonl'), jsonLines(calibration));
		writeFileSync(join(stage, 'manifest.json'), stableJson(manifestFor(stage)));
		verifySemanticEvidence(stage, cached, cliPath);
		if (mode === 'record') {
			if (existsSync(finalEvidence)) throw new Error('evidence appeared before promotion');
			renameSync(stage, finalEvidence);
			assertContained(evidenceParent, finalEvidence);
		} else {
			const backupName = `.superseded-${EVIDENCE_ID}-${process.pid}`;
			promoteDirectoryWithRollback(evidenceParent, stage, finalEvidence, backupName, () =>
				verifySemanticEvidence(finalEvidence, cached, cliPath),
			);
		}
	} catch (error) {
		if (existsSync(stage)) cleanupStage(evidenceParent, stage, stageName);
		throw error;
	}
}

export async function recordEvidence(args: readonly string[], cliPath: string): Promise<void> {
	await generateAndPromoteEvidence(args, cliPath, 'record');
}

export async function repairEvidence(args: readonly string[], cliPath: string): Promise<void> {
	await generateAndPromoteEvidence(args, cliPath, 'repair');
}

export function verifySemanticEvidence(
	evidenceRoot: string,
	cached: ReturnType<typeof cacheFinal>,
	cliPath: string,
): void {
	verifyManifest(evidenceRoot);
	const commands = JSON.parse(
		readFileSync(join(evidenceRoot, 'commands.json'), 'utf8'),
	) as CommandsEvidence;
	if (
		commands.evidenceId !== EVIDENCE_ID ||
		!VALID_SUPERSEDED_MANIFESTS.has(commands.supersededManifestSha256)
	)
		throw new Error('semantic command identity mismatch');
	const allGuessless: GuesslessEvidence[] = [];
	const allLsp: McplsEvidence[] = [];
	for (const repository of REPOSITORIES) {
		const path = join(evidenceRoot, 'raw', `${repository.id}.guessless.jsonl`);
		const recorded = parseJsonLines<GuesslessEvidence>(path);
		validateGuessless(recorded, repository.id);
		if (
			recorded.length !== 3 ||
			!recorded.some((item) => ['capturesOf', 'reachableFrom'].includes(item.query))
		)
			throw new Error(`${repository.id} Tier-2 evidence mismatch`);
		const reproduced = recordGuessless(repository.id, sourceRoot(cached, repository.id));
		if (stableJson(recorded) !== stableJson(reproduced))
			throw new Error(`${repository.id} offline Guessless replay mismatch`);
		allGuessless.push(...recorded);
		const lsp = JSON.parse(
			readFileSync(
				join(evidenceRoot, 'raw', `${repository.id}.mcpls.stdout.jsonl`),
				'utf8',
			).trim(),
		) as McplsEvidence;
		const definition = recorded.find((item) => item.query === 'definitionOf');
		if (definition === undefined)
			throw new Error(`${repository.id} definition evidence missing`);
		validateLspEvidence(
			lsp,
			repository.id,
			sourceRoot(cached, repository.id),
			definition.comparisonPosition,
			readFileSync(join(evidenceRoot, 'raw', `${repository.id}.mcpls.stderr.txt`), 'utf8'),
		);
		allLsp.push(lsp);
		const command = commands.nonbuild.find((item) => item.repository === repository.id);
		if (command === undefined) throw new Error(`${repository.id} nonbuild command missing`);
		validateNonbuildEvidence(
			{
				...command,
				stdout: readFileSync(
					join(evidenceRoot, 'raw', `${repository.id}.nonbuild.stdout.txt`),
					'utf8',
				),
				stderr: readFileSync(
					join(evidenceRoot, 'raw', `${repository.id}.nonbuild.stderr.txt`),
					'utf8',
				),
			},
			commands.supersededManifestSha256 === CLOSED_PREDECESSOR_MANIFEST_SHA256,
		);
	}
	if (
		commands.nonbuild.length !== REPOSITORIES.length ||
		commands.mcpls.length !== REPOSITORIES.length
	)
		throw new Error('semantic command repository count mismatch');
	for (const item of allLsp) {
		const command = commands.mcpls.find((entry) => entry.repository === item.repository);
		if (
			command === undefined ||
			stableJson(command.command) !== stableJson(item.command) ||
			stableJson(command.position) !== stableJson(item.position)
		)
			throw new Error(`${item.repository} mcpls command mismatch`);
	}
	const performance = parseJsonLines<PerformanceProcessEvidence>(
		join(evidenceRoot, 'raw', 'performance.jsonl'),
	);
	validatePerformance(performance, cliPath);
	if (
		stableJson(commands.performance) !==
		stableJson(
			performance.map((item) => ({
				lines: item.lines,
				command: item.command,
				timeoutMs: item.timeoutMs,
				maxOldSpaceMiB: item.maxOldSpaceMiB,
			})),
		)
	)
		throw new Error('performance command mismatch');
	const stateCensus = census(allGuessless);
	const summary = readFileSync(join(evidenceRoot, 'summary.md'), 'utf8');
	for (const required of [
		`Superseded manifest SHA-256: \`${commands.supersededManifestSha256}\`.`,
		`Receipt-state census: \`${JSON.stringify(stateCensus.states)}\`.`,
		`Named unresolved-reason census: \`${JSON.stringify(stateCensus.unresolvedReasons)}\`.`,
		`mcpls/typescript-language-server produced ${allLsp.filter((item) => item.usefulSuccess).length} useful repository comparisons.`,
		'The synthetic workload is one TypeScript file with nine fixed code lines plus comment padding.',
	])
		if (!summary.includes(required)) throw new Error('summary semantic mismatch');
}

export function verifyEvidence(args: readonly string[]): void {
	assertOffline();
	if (!args.includes('--offline')) throw new Error('verify requires --offline');
	const paths = deriveOraclePaths();
	const evidenceRoot = exactEvidencePath(args[args.indexOf('--evidence-dir') + 1], paths);
	assertRealDirectory(evidenceRoot, 'evidence root');
	assertContained(join(paths.root, 'docs/evidence'), evidenceRoot);
	verifySemanticEvidence(evidenceRoot, verifyCache(), join(paths.oraclePackage, 'dist/cli.js'));
}

export function verifyEvidenceCopy(evidenceRoot: string): void {
	verifySemanticEvidence(
		evidenceRoot,
		verifyCache(),
		join(deriveOraclePaths().oraclePackage, 'dist/cli.js'),
	);
}

export function resealEvidenceCopy(evidenceRoot: string): void {
	writeFileSync(join(evidenceRoot, 'manifest.json'), stableJson(manifestFor(evidenceRoot)));
}

export function calibrateEvidence(args: readonly string[]): void {
	assertOffline();
	if (!args.includes('--offline')) throw new Error('calibrate requires --offline');
	const paths = deriveOraclePaths();
	const evidenceRoot = exactEvidencePath(args[args.indexOf('--evidence-dir') + 1], paths);
	const cached = verifyCache();
	verifySemanticEvidence(evidenceRoot, cached, join(paths.oraclePackage, 'dist/cli.js'));
	const before = manifestFor(evidenceRoot);
	const expected = readFileSync(join(evidenceRoot, 'raw', 'calibration.jsonl'), 'utf8');
	const actual = jsonLines(calibrations(evidenceRoot, cached));
	const normalizeTemporaryRoot = (value: string): string =>
		value.replace(
			/(?:\/private)?\/(?:var\/folders\/[^/]+\/[^/]+\/T|tmp)\/guessless-calibration-[^/\\" ]+/g,
			'<temporary-root>',
		);
	if (normalizeTemporaryRoot(actual) !== normalizeTemporaryRoot(expected))
		throw new Error('calibration replay mismatch');
	const after = manifestFor(evidenceRoot);
	if (stableJson(before) !== stableJson(after))
		throw new Error('checked evidence changed during calibration');
}
