import type { Receipt, SafeChangeImpactResult } from '../../engine/src/index.ts';

export const PROOF_CACHE_CAPACITY = 8;
export const PROOF_CACHE_MAX_BYTES = 256 * 1024;

interface CacheEntry {
	readonly serialized: string;
	readonly bytes: number;
}

export class SafeChangeProofCache {
	readonly #capacity: number;
	readonly #maxBytes: number;
	readonly #receipts = new Map<string, CacheEntry>();
	#bytes = 0;

	constructor(capacity = PROOF_CACHE_CAPACITY, maxBytes = PROOF_CACHE_MAX_BYTES) {
		if (!Number.isSafeInteger(capacity) || capacity < 1)
			throw new RangeError('proof cache capacity must be a positive safe integer');
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new RangeError('proof cache maxBytes must be a positive safe integer');
		this.#capacity = capacity;
		this.#maxBytes = maxBytes;
	}

	get size(): number {
		return this.#receipts.size;
	}

	get bytes(): number {
		return this.#bytes;
	}

	set(receipt: Receipt<SafeChangeImpactResult>): boolean {
		const serialized = JSON.stringify(receipt);
		const bytes = Buffer.byteLength(serialized, 'utf8');
		if (bytes > this.#maxBytes) return false;
		const existing = this.#receipts.get(receipt.integrity);
		if (existing !== undefined) {
			this.#bytes -= existing.bytes;
			this.#receipts.delete(receipt.integrity);
		}
		this.#receipts.set(receipt.integrity, { serialized, bytes });
		this.#bytes += bytes;
		while (this.#receipts.size > this.#capacity || this.#bytes > this.#maxBytes) {
			const oldest = this.#receipts.keys().next().value as string;
			const evicted = this.#receipts.get(oldest)!;
			this.#receipts.delete(oldest);
			this.#bytes -= evicted.bytes;
		}
		return true;
	}

	refresh(proofHandle: string): boolean {
		const entry = this.#receipts.get(proofHandle);
		if (entry === undefined) return false;
		this.#receipts.delete(proofHandle);
		this.#receipts.set(proofHandle, entry);
		return true;
	}

	get(proofHandle: string): string | undefined {
		if (!this.refresh(proofHandle)) return undefined;
		return this.#receipts.get(proofHandle)!.serialized;
	}
}
