import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isAbsolute, normalize } from 'pathe';
import { z } from 'zod';
import type { Receipt, SafeChangeTarget, SymbolAnchor } from '../../engine/src/index.ts';
import { SafeChangePageCache, makeSafeChangePagedBundle } from './page-cache.ts';
import { SafeChangeProofCache } from './proof-cache.ts';
import { ROOT_SCAN_POLICY, scanStableRoot, type RootPreparationReason } from './root.ts';

const enginePackage: string = '@guessless/engine';
const { GuesslessEngine, SAFE_CHANGE_ROLES, UNRESOLVED_REASONS, safeChangeSummaryText } =
	(await import(enginePackage)) as typeof import('../../engine/src/index.ts');

const anchorSchema = z
	.strictObject({
		schema: z.literal('guessless.symbol-anchor/v1'),
		file: z.string(),
		semanticPath: z.array(z.string()).min(1),
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.transform((anchor) => anchor as SymbolAnchor);

const targetSchema = z.strictObject({ target: anchorSchema });
const fileSchema = z.strictObject({ file: z.string() });
const sourceSchema = z.strictObject({ path: z.string().min(1), source: z.string() });
const sourcePrepareSchema = z.strictObject({ sources: z.array(sourceSchema).min(1) });
const rootPrepareSchema = z.strictObject({ rootUri: z.string().min(1) });
const prepareSchema = z.union([sourcePrepareSchema, rootPrepareSchema]);
const safeChangeTargetSchema = z.union([
	anchorSchema,
	z
		.strictObject({
			file: z.string().min(1),
			name: z.string().min(1),
			space: z.enum(['value', 'type', 'namespace', 'typeof', 'any']),
			from: anchorSchema.optional(),
		})
		.transform((selector) => selector as SafeChangeTarget),
]);
const safeChangeSchema = z.strictObject({
	snapshot: z.string().regex(/^[a-f0-9]{64}$/),
	intent: z.enum(['rename', 'delete', 'entry-point']),
	target: safeChangeTargetSchema,
	view: z.enum(['summary', 'paged']).optional(),
});
const proofExpansionSchema = z.strictObject({
	proofHandle: z.string().regex(/^[a-f0-9]{64}$/),
});
const safeChangePageSchema = z.strictObject({
	pageHandle: z.string().regex(/^[a-f0-9]{64}$/),
	stream: z.enum(['semantic', 'proof']),
	cursor: z.string().min(1).optional(),
	filter: z
		.strictObject({
			file: z.string().min(1).optional(),
			role: z.enum(SAFE_CHANGE_ROLES).optional(),
			reason: z.enum(UNRESOLVED_REASONS).optional(),
		})
		.optional(),
});
const supportedSource = /\.(?:[cm]?[jt]s|jsx|tsx)$/;

interface PreparedSource {
	readonly path: string;
	readonly source: string;
	readonly sourceSha256: string;
}

interface PreparedSnapshot {
	readonly schema: 'guessless.prepared-snapshot/v1';
	readonly state: 'complete';
	readonly snapshot: string;
	readonly coverage: readonly {
		readonly path: string;
		readonly sourceSha256: string;
	}[];
	readonly fileCount: number;
}

interface PreparationRefusal {
	readonly schema: 'guessless.prepared-snapshot/v1';
	readonly state: 'refused';
	readonly snapshot: string;
	readonly reason:
		| 'unsafe-path'
		| 'duplicate-path'
		| 'unsupported-language'
		| 'source-rejected'
		| 'link-failed';
	readonly detail: string;
}

interface RootPreparationRefusal {
	readonly schema: 'guessless.root-prepared-snapshot/v1';
	readonly state: 'refused';
	readonly snapshot: string;
	readonly rootUri: string | null;
	readonly reason: RootPreparationReason | 'source-rejected' | 'link-failed';
	readonly detail: string;
}

function canonicalSourcePath(path: string): string | null {
	if (path.includes('\0')) return null;
	const canonical = normalize(path);
	if (
		canonical === '.' ||
		canonical.length === 0 ||
		isAbsolute(path) ||
		isAbsolute(canonical) ||
		/^[A-Za-z]:/.test(path) ||
		/^[A-Za-z]:/.test(canonical) ||
		canonical === '..' ||
		canonical.startsWith('../')
	)
		return null;
	return canonical;
}

function sourceSha256(source: string): string {
	return createHash('sha256').update(source, 'utf8').digest('hex');
}

function exactResult(value: object): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(value) }],
		structuredContent: value as Record<string, unknown>,
	};
}

function summaryResult(
	value: ReturnType<InstanceType<typeof GuesslessEngine>['safeChangeImpactSummary']>['summary'],
): CallToolResult {
	return {
		content: [{ type: 'text', text: safeChangeSummaryText(value) }],
		structuredContent: value as unknown as Record<string, unknown>,
	};
}

function isReceipt(value: unknown): value is Receipt<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'schema' in value &&
		value.schema === 'guessless.receipt/v1'
	);
}

export function createGuesslessMcpServer(
	engine: InstanceType<typeof GuesslessEngine> = new GuesslessEngine(),
	configuredRoot: string = process.cwd(),
	proofCache: SafeChangeProofCache = new SafeChangeProofCache(),
	pageCache: SafeChangePageCache = new SafeChangePageCache(),
): McpServer {
	const server = new McpServer({ name: '@guessless/mcp', version: '0.0.1' });
	let committedEngine = engine;

	const refusePreparation = (
		reason: PreparationRefusal['reason'],
		detail: string,
	): CallToolResult =>
		exactResult({
			schema: 'guessless.prepared-snapshot/v1',
			state: 'refused',
			snapshot: committedEngine.snapshot(),
			reason,
			detail,
		} satisfies PreparationRefusal);

	server.registerTool(
		'guessless_prepare_snapshot',
		{
			description:
				'Atomically prepare one immutable JavaScript/TypeScript snapshot from either a non-empty path/source batch or a bounded local file-root reference.',
			inputSchema: prepareSchema,
		},
		async (arguments_) => {
			if ('rootUri' in arguments_) {
				const scan = await scanStableRoot(arguments_.rootUri, configuredRoot);
				if ('state' in scan)
					return exactResult({
						schema: 'guessless.root-prepared-snapshot/v1',
						state: 'refused',
						snapshot: committedEngine.snapshot(),
						rootUri: scan.rootUri,
						reason: scan.reason,
						detail: scan.detail,
					} satisfies RootPreparationRefusal);
				const staged = new GuesslessEngine();
				for (const source of scan.files) {
					const added = staged.addFile(source.path, source.source);
					if (isReceipt(added))
						return exactResult({
							schema: 'guessless.root-prepared-snapshot/v1',
							state: 'refused',
							snapshot: committedEngine.snapshot(),
							rootUri: scan.rootUri,
							reason: 'source-rejected',
							detail: `Source '${source.path}' was rejected with state '${added.state}'${
								added.state === 'refused' ? ` and reason '${added.reason}'` : ''
							}.`,
						} satisfies RootPreparationRefusal);
				}
				try {
					staged.link();
				} catch (error) {
					return exactResult({
						schema: 'guessless.root-prepared-snapshot/v1',
						state: 'refused',
						snapshot: committedEngine.snapshot(),
						rootUri: scan.rootUri,
						reason: 'link-failed',
						detail: `Staged snapshot link failed: ${error instanceof Error ? error.message : String(error)}`,
					} satisfies RootPreparationRefusal);
				}
				const result = {
					schema: 'guessless.root-prepared-snapshot/v1' as const,
					state: 'complete' as const,
					snapshot: staged.snapshot(),
					rootUri: scan.rootUri,
					policy: ROOT_SCAN_POLICY,
					scanDigest: scan.scanDigest,
					coverage: scan.coverage,
					fileCount: scan.fileCount,
					indexedBytes: scan.indexedBytes,
					outsideLanguageBoundary: scan.outsideLanguageBoundary,
					excludedRootPolicy: {
						directoryNames: ROOT_SCAN_POLICY.excludedDirectoryNames,
						encountered: scan.excludedDirectories,
					},
				};
				committedEngine = staged;
				return exactResult(result);
			}
			const { sources } = arguments_;
			const prepared: PreparedSource[] = [];
			const canonicalPaths = new Set<string>();
			for (const source of sources) {
				const path = canonicalSourcePath(source.path);
				if (path === null)
					return refusePreparation(
						'unsafe-path',
						`Source path '${source.path}' is not a safe workspace-relative path.`,
					);
				if (!supportedSource.test(path))
					return refusePreparation(
						'unsupported-language',
						`Source path '${path}' is outside the JavaScript/TypeScript boundary.`,
					);
				if (canonicalPaths.has(path))
					return refusePreparation(
						'duplicate-path',
						`Canonical source path '${path}' occurs more than once.`,
					);
				canonicalPaths.add(path);
				prepared.push({
					path,
					source: source.source,
					sourceSha256: sourceSha256(source.source),
				});
			}
			prepared.sort((left, right) => left.path.localeCompare(right.path));
			const staged = new GuesslessEngine();
			for (const source of prepared) {
				const added = staged.addFile(source.path, source.source);
				if (isReceipt(added))
					return refusePreparation(
						'source-rejected',
						`Source '${source.path}' was rejected with state '${added.state}'${
							added.state === 'refused' ? ` and reason '${added.reason}'` : ''
						}.`,
					);
			}
			try {
				staged.link();
			} catch (error) {
				return refusePreparation(
					'link-failed',
					`Staged snapshot link failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const result: PreparedSnapshot = {
				schema: 'guessless.prepared-snapshot/v1',
				state: 'complete',
				snapshot: staged.snapshot(),
				coverage: prepared.map(({ path, sourceSha256 }) => ({ path, sourceSha256 })),
				fileCount: prepared.length,
			};
			committedEngine = staged;
			return exactResult(result);
		},
	);

	server.registerTool(
		'guessless_add_file',
		{
			description: 'Add or replace one in-memory JavaScript/TypeScript source file.',
			inputSchema: z.strictObject({ path: z.string(), source: z.string() }),
		},
		({ path, source }) => {
			const added = committedEngine.addFile(path, source);
			return isReceipt(added)
				? exactResult(added)
				: exactResult({ kind: 'operation', operation: 'addFile', ok: true, file: path });
		},
	);

	server.registerTool(
		'guessless_remove_file',
		{
			description: 'Remove one source file from the in-memory linked set.',
			inputSchema: z.strictObject({ path: z.string() }),
		},
		({ path }) =>
			exactResult({
				kind: 'operation',
				operation: 'removeFile',
				ok: committedEngine.removeFile(path),
				file: path,
			}),
	);

	server.registerTool(
		'guessless_link',
		{
			description: 'Link all files currently held by this server instance.',
			inputSchema: z.strictObject({}),
		},
		() => {
			committedEngine.link();
			return exactResult({
				kind: 'operation',
				operation: 'link',
				ok: true,
				snapshot: committedEngine.snapshot(),
			});
		},
	);

	server.registerTool(
		'guessless_safe_change_impact',
		{
			description:
				'Return integrity-bound, fail-closed structural impact for one rename, delete, or entry-point intent against an exact prepared snapshot.',
			inputSchema: safeChangeSchema,
		},
		({ snapshot, intent, target, view }) => {
			if (view === undefined)
				return exactResult(committedEngine.safeChangeImpact(snapshot, intent, target));
			if (view === 'paged') {
				const receipt = committedEngine.safeChangeImpact(snapshot, intent, target);
				return exactResult(pageCache.set(makeSafeChangePagedBundle(receipt)));
			}
			const { receipt, summary } = committedEngine.safeChangeImpactSummary(
				snapshot,
				intent,
				target,
			);
			if (!proofCache.refresh(receipt.integrity) && !proofCache.set(receipt))
				return exactResult(receipt);
			return summaryResult(summary);
		},
	);

	server.registerTool(
		'guessless_safe_change_page',
		{
			description:
				'Return one bounded, cursor-bound semantic or byte-exact proof page for an opt-in paged safe-change result.',
			inputSchema: safeChangePageSchema,
		},
		(arguments_) => exactResult(pageCache.page(arguments_)),
	);

	server.registerTool(
		'guessless_expand_safe_change_proof',
		{
			description: 'Return the exact cached full receipt for an opt-in safe-change summary.',
			inputSchema: proofExpansionSchema,
		},
		({ proofHandle }) => {
			const serialized = proofCache.get(proofHandle);
			if (serialized !== undefined)
				return {
					content: [{ type: 'text', text: serialized }],
					structuredContent: JSON.parse(serialized) as Record<string, unknown>,
				};
			return exactResult({
				schema: 'guessless.proof-expansion/v1',
				state: 'refused',
				proofHandle,
				reason: 'unknown-proof-handle',
				detail: 'Proof handle is unknown or was evicted from this server instance.',
			});
		},
	);

	server.registerTool(
		'guessless_definition_of',
		{ description: 'Return the exact definitionOf engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.definitionOf(target)),
	);
	server.registerTool(
		'guessless_references_of',
		{ description: 'Return the exact referencesOf engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.referencesOf(target)),
	);
	server.registerTool(
		'guessless_reads_of',
		{ description: 'Return the exact readsOf engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.readsOf(target)),
	);
	server.registerTool(
		'guessless_writes_of',
		{ description: 'Return the exact writesOf engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.writesOf(target)),
	);
	server.registerTool(
		'guessless_exported_names',
		{ description: 'Return the exact exportedNames engine receipt.', inputSchema: fileSchema },
		({ file }) => exactResult(committedEngine.exportedNames(file)),
	);
	server.registerTool(
		'guessless_captures_of',
		{ description: 'Return the exact capturesOf engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.capturesOf(target)),
	);
	server.registerTool(
		'guessless_resolve_binding',
		{
			description: 'Return the exact resolveBinding engine receipt.',
			inputSchema: z.strictObject({
				file: z.string(),
				name: z.string(),
				space: z.enum(['value', 'type', 'namespace', 'typeof', 'any']).optional(),
				from: anchorSchema.optional(),
			}),
		},
		({ file, name, space, from }) =>
			exactResult(committedEngine.resolveBinding(file, name, space, from)),
	);
	server.registerTool(
		'guessless_reachable_from',
		{
			description: 'Return the exact reachableFrom engine receipt.',
			inputSchema: targetSchema,
		},
		({ target }) => exactResult(committedEngine.reachableFrom(target)),
	);
	server.registerTool(
		'guessless_reaches',
		{ description: 'Return the exact reaches engine receipt.', inputSchema: targetSchema },
		({ target }) => exactResult(committedEngine.reaches(target)),
	);

	return server;
}

export { GuesslessEngine };
