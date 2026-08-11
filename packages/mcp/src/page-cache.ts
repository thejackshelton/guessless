import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type {
	QueryRequest,
	Receipt,
	SafeChangeImpactResult,
	SafeChangeRole,
	SymbolAnchor,
	UnresolvedReason,
} from '../../engine/src/index.ts';

const enginePackage: string = '@guessless/engine';
const { UNRESOLVED_REASONS, verifyReceipt } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

export const PAGED_CALL_TOOL_MAX_BYTES = 8_192;
export const PAGE_CACHE_CAPACITY = 8;
export const PAGE_CACHE_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const PAGE_CACHE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const PROOF_CHUNK_BYTES = 1_800;
const MAX_CURSOR_BYTES = 2_048;
const CURSOR_FIELDS = ['cache', 'handle', 'stream', 'filter', 'index', 'digest'] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CACHE_NONCE_HEX = /^[a-f0-9]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface SafeChangePagedFact {
	readonly id: string;
	readonly classification: 'resolved' | 'unresolved';
	readonly file: string;
	readonly label: string;
	readonly projection: {
		readonly fingerprint: string;
		readonly semanticPathDigests: readonly string[];
	};
	readonly roles?: readonly SafeChangeRole[];
	readonly reason?: UnresolvedReason;
}

export interface SafeChangePagedBundle {
	readonly proofHandle: string;
	readonly proof: string;
	readonly facts: readonly SafeChangePagedFact[];
	readonly baseHead: Omit<SafeChangePagedHead, 'integrity' | 'semantic' | 'proof'>;
}

export interface SafeChangePagedHead {
	readonly schema: 'guessless.safe-change-paged/v1';
	readonly state: 'complete' | 'partial' | 'refused';
	readonly request: Extract<QueryRequest, { kind: 'safeChangeImpact' }>;
	readonly snapshot: string;
	readonly proofHandle: string;
	readonly counts: {
		readonly sites: number;
		readonly resolved: number;
		readonly unresolved: number;
		readonly classified: number;
		readonly receiptResolved: number;
		readonly receiptUnresolved: number;
	};
	readonly unresolvedReasonCounts: Readonly<Record<UnresolvedReason, number>>;
	readonly factRoot: string;
	readonly semantic: { readonly pages: number; readonly firstCursor: string };
	readonly proof: {
		readonly sha256: string;
		readonly bytes: number;
		readonly pages: number;
		readonly firstCursor: string;
	};
	readonly reason?: UnresolvedReason;
	readonly detail?: string;
	readonly integrity: string;
}

export interface PageFilter {
	readonly file?: string;
	readonly role?: string;
	readonly reason?: string;
}

export interface PageRequest {
	readonly pageHandle: string;
	readonly stream: 'semantic' | 'proof';
	readonly cursor?: string;
	readonly filter?: PageFilter;
}

export interface PageRefusal {
	readonly schema: 'guessless.safe-change-page/v1';
	readonly state: 'refused';
	readonly pageHandle: string;
	readonly reason:
		| 'unknown-page-handle'
		| 'invalid-page-cursor'
		| 'paged-transport-limit'
		| 'paged-proof-too-large';
	readonly detail: string;
}

interface Entry {
	readonly bundle: SafeChangePagedBundle;
	readonly compressedProof: Buffer;
	readonly proof: Buffer;
	readonly proofBytes: number;
	readonly proofDigest: string;
	semanticFull?: SemanticPagination;
}

interface SemanticPagination {
	readonly facts: SafeChangePagedFact[];
	readonly pages: SafeChangePagedFact[][];
	readonly digest: string;
}

interface CursorPayload {
	readonly cache: string;
	readonly handle: string;
	readonly stream: 'semantic' | 'proof';
	readonly filter: string;
	readonly index: number;
	readonly digest: string;
}

function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function label(anchor: SymbolAnchor): string {
	return (
		anchor.semanticPath.find((part) => part.startsWith('symbol:')) ??
		anchor.semanticPath.find((part) => part.startsWith('site:')) ??
		anchor.semanticPath.find((part) => part.startsWith('module:')) ??
		anchor.semanticPath[0]!
	);
}

function resolvedFact(result: SafeChangeImpactResult): SafeChangePagedFact {
	const projection = {
		fingerprint: result.site.fingerprint,
		semanticPathDigests: [hash(JSON.stringify(result.site.semanticPath))],
	};
	return {
		id: hash(JSON.stringify(['resolved', result.site.file, projection, result.roles])),
		classification: 'resolved',
		file: result.site.file,
		label: label(result.site),
		projection,
		roles: result.roles,
	};
}

function projectionKey(anchor: SymbolAnchor, reason: UnresolvedReason): string {
	const semanticPath = [...anchor.semanticPath];
	if (semanticPath[0] === 'site:reachability-import-boundary')
		semanticPath[0] = 'site:import-boundary';
	return JSON.stringify([anchor.file, anchor.fingerprint, semanticPath, reason]);
}

export function makeSafeChangePagedBundle(
	receipt: Receipt<SafeChangeImpactResult>,
): SafeChangePagedBundle {
	if (!verifyReceipt(receipt) || receipt.query !== 'safeChangeImpact')
		throw new TypeError('paged safe change requires one valid safeChangeImpact receipt');
	const facts: SafeChangePagedFact[] = receipt.results.map(resolvedFact);
	const unresolved = receipt.state === 'partial' ? receipt.unresolved : [];
	const unresolvedByProjection = new Map<string, SafeChangePagedFact>();
	for (const item of unresolved) {
		const key = projectionKey(item.site, item.reason);
		const previous = unresolvedByProjection.get(key);
		if (previous !== undefined) {
			const semanticPathDigests = [
				...previous.projection.semanticPathDigests,
				hash(JSON.stringify(item.site.semanticPath)),
			];
			unresolvedByProjection.set(key, {
				...previous,
				projection: { ...previous.projection, semanticPathDigests },
			});
			continue;
		}
		unresolvedByProjection.set(key, {
			id: hash(
				JSON.stringify(['unresolved', item.site.file, item.site.fingerprint, item.reason]),
			),
			classification: 'unresolved',
			file: item.site.file,
			label: label(item.site),
			projection: {
				fingerprint: item.site.fingerprint,
				semanticPathDigests: [hash(JSON.stringify(item.site.semanticPath))],
			},
			reason: item.reason,
		});
	}
	facts.push(...unresolvedByProjection.values());
	const unresolvedReasonCounts = Object.fromEntries(
		UNRESOLVED_REASONS.map((reason) => [
			reason,
			facts.filter((fact) => fact.classification === 'unresolved' && fact.reason === reason)
				.length,
		]),
	) as Record<UnresolvedReason, number>;
	const proof = JSON.stringify(receipt);
	const siteCount = new Set(
		facts.map((fact) => JSON.stringify([fact.file, fact.projection.fingerprint])),
	).size;
	const request = receipt.request as Extract<QueryRequest, { kind: 'safeChangeImpact' }>;
	const base = {
		schema: 'guessless.safe-change-paged/v1' as const,
		state: receipt.state,
		request,
		snapshot: receipt.snapshot,
		proofHandle: receipt.integrity,
		counts: {
			sites: siteCount,
			resolved: receipt.results.length,
			unresolved: unresolvedByProjection.size,
			classified: facts.length,
			receiptResolved: receipt.results.length,
			receiptUnresolved: unresolved.length,
		},
		unresolvedReasonCounts,
		factRoot: hash(JSON.stringify(facts)),
		...(receipt.state === 'refused' ? { reason: receipt.reason, detail: receipt.detail } : {}),
	};
	return { proofHandle: receipt.integrity, proof, facts, baseHead: base };
}

function finalizeSafeChangePagedHead(
	bundle: SafeChangePagedBundle,
	semantic: SafeChangePagedHead['semantic'],
	proof: SafeChangePagedHead['proof'],
): SafeChangePagedHead {
	const unsigned = { ...bundle.baseHead, semantic, proof };
	return { ...unsigned, integrity: hash(JSON.stringify(unsigned)) };
}

export function completeCallToolResultBytes(value: object): number {
	const text = JSON.stringify(value);
	return Buffer.byteLength(
		JSON.stringify({ content: [{ type: 'text', text }], structuredContent: value }),
		'utf8',
	);
}

function normalizedFilter(filter?: PageFilter): PageFilter | null {
	if (filter === undefined) return null;
	const normalized = Object.fromEntries(
		(['file', 'role', 'reason'] as const)
			.filter((key) => filter[key] !== undefined)
			.map((key) => [key, filter[key]]),
	) as PageFilter;
	return Object.keys(normalized).length === 0 ? null : normalized;
}

function filterFacts(facts: readonly SafeChangePagedFact[], filter: PageFilter | null) {
	if (filter === null) return [...facts];
	return facts.filter(
		(fact) =>
			(filter.file === undefined || fact.file === filter.file) &&
			(filter.role === undefined || fact.roles?.includes(filter.role as never) === true) &&
			(filter.reason === undefined || fact.reason === filter.reason),
	);
}

export class SafeChangePageCache {
	readonly #capacity: number;
	readonly #maxCompressedBytes: number;
	readonly #maxUncompressedBytes: number;
	readonly #cacheId = randomBytes(16).toString('hex');
	readonly #cursorKey = randomBytes(32);
	readonly #entries = new Map<string, Entry>();
	#compressedBytes = 0;

	constructor(
		capacity = PAGE_CACHE_CAPACITY,
		maxCompressedBytes = PAGE_CACHE_MAX_COMPRESSED_BYTES,
		maxUncompressedBytes = PAGE_CACHE_MAX_UNCOMPRESSED_BYTES,
	) {
		for (const [name, value] of [
			['capacity', capacity],
			['compressed bytes', maxCompressedBytes],
			['uncompressed bytes', maxUncompressedBytes],
		] as const)
			if (!Number.isSafeInteger(value) || value < 1)
				throw new RangeError(`page cache ${name} must be a positive safe integer`);
		this.#capacity = capacity;
		this.#maxCompressedBytes = maxCompressedBytes;
		this.#maxUncompressedBytes = maxUncompressedBytes;
	}

	get size(): number {
		return this.#entries.size;
	}

	get compressedBytes(): number {
		return this.#compressedBytes;
	}

	#cursor(payload: Omit<CursorPayload, 'cache'>): string {
		const full = { cache: this.#cacheId, ...payload } satisfies CursorPayload;
		const body = Buffer.from(JSON.stringify(full)).toString('base64url');
		const signature = createHmac('sha256', this.#cursorKey).update(body).digest('hex');
		return `${body}.${signature}`;
	}

	#parseCursor(cursor: string): CursorPayload | null {
		if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) return null;
		const [body, signature, ...extra] = cursor.split('.');
		if (body === undefined || signature === undefined || extra.length > 0) return null;
		if (!BASE64URL.test(body) || !SHA256_HEX.test(signature)) return null;
		const suppliedSignature = Buffer.from(signature, 'hex');
		const expectedSignature = createHmac('sha256', this.#cursorKey).update(body).digest();
		if (
			suppliedSignature.byteLength !== expectedSignature.byteLength ||
			!timingSafeEqual(suppliedSignature, expectedSignature)
		)
			return null;
		try {
			const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record);
			if (
				keys.length !== CURSOR_FIELDS.length ||
				!CURSOR_FIELDS.every((key) => keys.includes(key))
			)
				return null;
			if (
				typeof record.cache !== 'string' ||
				!CACHE_NONCE_HEX.test(record.cache) ||
				record.cache !== this.#cacheId ||
				typeof record.handle !== 'string' ||
				!SHA256_HEX.test(record.handle) ||
				(record.stream !== 'semantic' && record.stream !== 'proof') ||
				typeof record.filter !== 'string' ||
				!SHA256_HEX.test(record.filter) ||
				typeof record.index !== 'number' ||
				!Number.isSafeInteger(record.index) ||
				record.index < 0 ||
				typeof record.digest !== 'string' ||
				!SHA256_HEX.test(record.digest)
			)
				return null;
			return record as unknown as CursorPayload;
		} catch {
			return null;
		}
	}

	#refresh(handle: string): Entry | undefined {
		const entry = this.#entries.get(handle);
		if (entry === undefined) return undefined;
		this.#entries.delete(handle);
		this.#entries.set(handle, entry);
		return entry;
	}

	#semanticPages(entry: Entry, filter: PageFilter | null): SemanticPagination | null {
		if (filter === null && entry.semanticFull !== undefined) return entry.semanticFull;
		const facts = filterFacts(entry.bundle.facts, filter);
		const digest = hash(JSON.stringify(facts));
		const pages: SafeChangePagedFact[][] = [];
		for (const fact of facts) {
			const current = pages.at(-1) ?? [];
			const candidate = [...current, fact];
			const probe = {
				schema: 'guessless.safe-change-page/v1',
				state: 'complete',
				pageHandle: entry.bundle.proofHandle,
				stream: 'semantic',
				coverage: filter === null ? 'full' : 'filtered',
				filter,
				filterDigest: hash(JSON.stringify(filter)),
				factRoot: entry.bundle.baseHead.factRoot,
				resultDigest: digest,
				counts: { parent: entry.bundle.facts.length, filtered: facts.length },
				index: pages.length,
				facts: candidate,
				nextCursor: 'x'.repeat(512),
			};
			if (completeCallToolResultBytes(probe) <= PAGED_CALL_TOOL_MAX_BYTES) {
				if (current.length === 0) pages.push(candidate);
				else pages[pages.length - 1] = candidate;
				continue;
			}
			if (current.length === 0) return null;
			pages.push([fact]);
			if (
				completeCallToolResultBytes({ ...probe, index: pages.length - 1, facts: [fact] }) >
				PAGED_CALL_TOOL_MAX_BYTES
			)
				return null;
		}
		if (pages.length === 0) pages.push([]);
		return { facts, pages, digest };
	}

	set(bundle: SafeChangePagedBundle): SafeChangePagedHead | PageRefusal {
		const proof = Buffer.from(bundle.proof);
		const proofBytes = proof.byteLength;
		if (proofBytes > this.#maxUncompressedBytes)
			return this.#refusal(
				bundle.proofHandle,
				'paged-proof-too-large',
				'Exact proof exceeds the 64 MiB per-handle limit.',
			);
		const compressedProof = gzipSync(proof);
		if (compressedProof.byteLength > this.#maxCompressedBytes)
			return this.#refusal(
				bundle.proofHandle,
				'paged-transport-limit',
				'Compressed proof exceeds the aggregate cache limit.',
			);
		const prior = this.#entries.get(bundle.proofHandle);
		if (prior !== undefined) {
			this.#compressedBytes -= prior.compressedProof.byteLength;
			this.#entries.delete(bundle.proofHandle);
		}
		const entry: Entry = {
			bundle,
			compressedProof,
			proof,
			proofBytes,
			proofDigest: hash(proof),
		};
		this.#entries.set(bundle.proofHandle, entry);
		this.#compressedBytes += compressedProof.byteLength;
		while (
			this.#entries.size > this.#capacity ||
			this.#compressedBytes > this.#maxCompressedBytes
		) {
			const oldest = this.#entries.keys().next().value as string;
			const evicted = this.#entries.get(oldest)!;
			this.#entries.delete(oldest);
			this.#compressedBytes -= evicted.compressedProof.byteLength;
		}
		if (!this.#entries.has(bundle.proofHandle))
			return this.#refusal(
				bundle.proofHandle,
				'paged-transport-limit',
				'Page bundle cannot fit the bounded cache.',
			);
		const semantic = this.#semanticPages(entry, null);
		if (semantic === null) {
			this.delete(bundle.proofHandle);
			return this.#refusal(
				bundle.proofHandle,
				'paged-transport-limit',
				'One semantic fact cannot fit an 8192-byte response.',
			);
		}
		entry.semanticFull = semantic;
		const semanticCursor = this.#cursor({
			handle: bundle.proofHandle,
			stream: 'semantic',
			filter: hash(JSON.stringify(null)),
			index: 0,
			digest: semantic.digest,
		});
		const proofDigest = entry.proofDigest;
		const proofPages = Math.max(1, Math.ceil(proofBytes / PROOF_CHUNK_BYTES));
		const proofCursor = this.#cursor({
			handle: bundle.proofHandle,
			stream: 'proof',
			filter: hash(JSON.stringify(null)),
			index: 0,
			digest: proofDigest,
		});
		const head = finalizeSafeChangePagedHead(
			bundle,
			{ pages: semantic.pages.length, firstCursor: semanticCursor },
			{
				sha256: proofDigest,
				bytes: proofBytes,
				pages: proofPages,
				firstCursor: proofCursor,
			},
		);
		if (completeCallToolResultBytes(head) > PAGED_CALL_TOOL_MAX_BYTES) {
			this.delete(bundle.proofHandle);
			return this.#refusal(
				bundle.proofHandle,
				'paged-transport-limit',
				'Paged head exceeds the 8192-byte response limit.',
			);
		}
		return head;
	}

	delete(handle: string): void {
		const entry = this.#entries.get(handle);
		if (entry === undefined) return;
		this.#compressedBytes -= entry.compressedProof.byteLength;
		this.#entries.delete(handle);
	}

	page(request: PageRequest): object {
		const entry = this.#refresh(request.pageHandle);
		if (entry === undefined)
			return this.#refusal(
				request.pageHandle,
				'unknown-page-handle',
				'Page handle is unknown or was evicted from this server instance.',
			);
		const filter = normalizedFilter(request.filter);
		if (request.stream === 'proof' && filter !== null)
			return this.#refusal(
				request.pageHandle,
				'invalid-page-cursor',
				'Proof pages do not accept semantic filters.',
			);
		const filterDigest = hash(JSON.stringify(filter));
		if (request.stream === 'semantic') {
			const semantic = this.#semanticPages(entry, filter);
			if (semantic === null)
				return this.#refusal(
					request.pageHandle,
					'paged-transport-limit',
					'One filtered fact cannot fit an 8192-byte response.',
				);
			const parsed = request.cursor === undefined ? null : this.#parseCursor(request.cursor);
			const index = parsed?.index ?? 0;
			if (
				(request.cursor !== undefined && parsed === null) ||
				(parsed !== null &&
					(parsed.handle !== request.pageHandle ||
						parsed.stream !== request.stream ||
						parsed.filter !== filterDigest ||
						parsed.digest !== semantic.digest)) ||
				index < 0 ||
				index >= semantic.pages.length
			)
				return this.#refusal(
					request.pageHandle,
					'invalid-page-cursor',
					'Cursor is forged, stale, or bound to different page parameters.',
				);
			const nextCursor =
				index + 1 < semantic.pages.length
					? this.#cursor({
							handle: request.pageHandle,
							stream: 'semantic',
							filter: filterDigest,
							index: index + 1,
							digest: semantic.digest,
						})
					: null;
			const value = {
				schema: 'guessless.safe-change-page/v1' as const,
				state: 'complete' as const,
				pageHandle: request.pageHandle,
				stream: 'semantic' as const,
				coverage: filter === null ? ('full' as const) : ('filtered' as const),
				filter,
				filterDigest,
				factRoot: entry.bundle.baseHead.factRoot,
				resultDigest: semantic.digest,
				counts: { parent: entry.bundle.facts.length, filtered: semantic.facts.length },
				index,
				facts: semantic.pages[index]!,
				nextCursor,
			};
			return completeCallToolResultBytes(value) <= PAGED_CALL_TOOL_MAX_BYTES
				? value
				: this.#refusal(
						request.pageHandle,
						'paged-transport-limit',
						'Semantic page exceeds 8192 bytes.',
					);
		}
		const digest = entry.proofDigest;
		const pages = Math.max(1, Math.ceil(entry.proofBytes / PROOF_CHUNK_BYTES));
		const parsed = request.cursor === undefined ? null : this.#parseCursor(request.cursor);
		const index = parsed?.index ?? 0;
		if (
			(request.cursor !== undefined && parsed === null) ||
			(parsed !== null &&
				(parsed.handle !== request.pageHandle ||
					parsed.stream !== 'proof' ||
					parsed.filter !== filterDigest ||
					parsed.digest !== digest)) ||
			index < 0 ||
			index >= pages
		)
			return this.#refusal(
				request.pageHandle,
				'invalid-page-cursor',
				'Cursor is forged, stale, or bound to different page parameters.',
			);
		const source = entry.proof;
		const start = index * PROOF_CHUNK_BYTES;
		const end = Math.min(start + PROOF_CHUNK_BYTES, source.byteLength);
		const nextCursor =
			index + 1 < pages
				? this.#cursor({
						handle: request.pageHandle,
						stream: 'proof',
						filter: filterDigest,
						index: index + 1,
						digest,
					})
				: null;
		const value = {
			schema: 'guessless.safe-change-page/v1' as const,
			state: 'complete' as const,
			pageHandle: request.pageHandle,
			stream: 'proof' as const,
			index,
			byteStart: start,
			byteEnd: end,
			proofBytes: entry.proofBytes,
			proofSha256: digest,
			chunkBase64: source.subarray(start, end).toString('base64'),
			nextCursor,
		};
		return completeCallToolResultBytes(value) <= PAGED_CALL_TOOL_MAX_BYTES
			? value
			: this.#refusal(
					request.pageHandle,
					'paged-transport-limit',
					'Proof page exceeds 8192 bytes.',
				);
	}

	#refusal(pageHandle: string, reason: PageRefusal['reason'], detail: string): PageRefusal {
		return {
			schema: 'guessless.safe-change-page/v1',
			state: 'refused',
			pageHandle,
			reason,
			detail,
		};
	}
}
