import { canonicalize, sha256 } from './canonicalize.ts';

export const UNRESOLVED_REASONS = [
	'unparsed-file',
	'unsupported-language',
	'unsupported-syntax',
	'unresolved-specifier',
	'external-module-boundary',
	'builtin-module-boundary',
	'linked-set-boundary',
	'unresolved-symbol',
	'ambiguous-definition',
	'dynamic-member-access',
	'computed-property-key',
	'string-keyed-lookup',
	'property-alias-write-uncertain',
	'higher-order-call-boundary',
	'stale-snapshot',
] as const;

export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

export interface SymbolAnchor {
	readonly schema: 'guessless.symbol-anchor/v1';
	readonly file: string;
	readonly semanticPath: readonly string[];
	readonly fingerprint: string;
}

export interface UnresolvedSite {
	readonly site: SymbolAnchor;
	readonly reason: UnresolvedReason;
	readonly detail: string;
}

export const SAFE_CHANGE_ROLES = [
	'declaration',
	'reference',
	'read',
	'write',
	'read-write',
	'call',
	'import',
	'export',
	'alias',
	'namespace',
	'barrel',
	'witness',
] as const;

export type SafeChangeRole = (typeof SAFE_CHANGE_ROLES)[number];
export type SafeChangeIntent = 'rename' | 'delete' | 'entry-point';
export interface SafeChangeBindingSelector {
	readonly file: string;
	readonly name: string;
	readonly space: 'value' | 'type' | 'namespace' | 'typeof' | 'any';
	readonly from?: SymbolAnchor;
}
export type SafeChangeTarget = SymbolAnchor | SafeChangeBindingSelector;

export interface SafeChangeImpactResult {
	readonly site: SymbolAnchor;
	readonly roles: readonly SafeChangeRole[];
	readonly witness: readonly SymbolAnchor[];
}

export type QueryRequest =
	| { readonly kind: 'addFile'; readonly file: string }
	| {
			readonly kind:
				| 'definitionOf'
				| 'referencesOf'
				| 'readsOf'
				| 'writesOf'
				| 'capturesOf'
				| 'reachableFrom'
				| 'reaches';
			readonly target: SymbolAnchor;
	  }
	| { readonly kind: 'exportedNames'; readonly file: string }
	| {
			readonly kind: 'resolveBinding';
			readonly file: string;
			readonly name: string;
			readonly space: 'value' | 'type' | 'namespace' | 'typeof' | 'any';
			readonly scope: SymbolAnchor | null;
	  }
	| {
			readonly kind: 'safeChangeImpact';
			readonly snapshot: string;
			readonly intent: SafeChangeIntent;
			readonly target: SafeChangeTarget;
	  };

interface ReceiptBase<T> {
	readonly schema: 'guessless.receipt/v1';
	readonly query: string;
	readonly request: QueryRequest;
	readonly snapshot: string;
	readonly results: readonly T[];
	readonly integrity: string;
}

export interface CompleteReceipt<T> extends ReceiptBase<T> {
	readonly state: 'complete';
}
export interface PartialReceipt<T> extends ReceiptBase<T> {
	readonly state: 'partial';
	readonly unresolved: readonly UnresolvedSite[];
}
export interface RefusedReceipt<T> extends ReceiptBase<T> {
	readonly state: 'refused';
	readonly reason: UnresolvedReason;
	readonly detail: string;
}
export type Receipt<T> = CompleteReceipt<T> | PartialReceipt<T> | RefusedReceipt<T>;
type WithoutIntegrity<T> = T extends unknown ? Omit<T, 'integrity'> : never;
type UnsignedReceipt<T> = WithoutIntegrity<Receipt<T>>;

const baseKeys = ['query', 'request', 'results', 'schema', 'snapshot', 'state'] as const;
const anchorKeys = ['file', 'fingerprint', 'schema', 'semanticPath'] as const;

export function makeReceipt<T>(receipt: UnsignedReceipt<T>): Receipt<T> {
	assertReceiptShape(receipt);
	return { ...receipt, integrity: sha256(receipt) } as Receipt<T>;
}

export function verifyReceipt(value: unknown, currentSnapshot?: string): value is Receipt<unknown> {
	try {
		assertReceiptShape(value);
		const record = value as Record<string, unknown>;
		if (typeof record.integrity !== 'string' || !/^[a-f0-9]{64}$/.test(record.integrity))
			return false;
		if (currentSnapshot !== undefined && record.snapshot !== currentSnapshot) return false;
		const { integrity, ...unsigned } = record;
		return integrity === sha256(unsigned);
	} catch {
		return false;
	}
}

function exactKeys(record: Record<string, unknown>, extras: readonly string[]): void {
	const expected = [
		...baseKeys,
		...extras,
		...('integrity' in record ? ['integrity'] : []),
	].sort();
	const actual = Object.keys(record).sort();
	if (actual.join('\u0000') !== expected.join('\u0000'))
		throw new TypeError('receipt state has invalid or cross-state fields');
}

function assertReceiptShape(value: unknown): void {
	if (!isRecord(value) || Array.isArray(value))
		throw new TypeError('receipt must be an object, never a bare list');
	const record = value;
	if (
		record.schema !== 'guessless.receipt/v1' ||
		typeof record.query !== 'string' ||
		!Array.isArray(record.results) ||
		typeof record.snapshot !== 'string' ||
		!/^[a-f0-9]{64}$/.test(record.snapshot)
	)
		throw new TypeError('invalid receipt envelope');
	assertRequest(record.query, record.request);
	if (record.state === 'complete') exactKeys(record, []);
	else if (record.state === 'partial') {
		exactKeys(record, ['unresolved']);
		if (!Array.isArray(record.unresolved) || record.unresolved.length === 0)
			throw new TypeError('partial receipt needs unresolved sites');
		for (const item of record.unresolved) assertUnresolved(item);
	} else if (record.state === 'refused') {
		exactKeys(record, ['detail', 'reason']);
		if (
			record.results.length !== 0 ||
			!isReason(record.reason) ||
			typeof record.detail !== 'string'
		)
			throw new TypeError('invalid refused receipt');
	} else throw new TypeError('receipt state must be complete, partial, or refused');
	assertQueryResults(record.query, record.results);
}

function assertRequest(query: string, value: unknown): asserts value is QueryRequest {
	if (!isRecord(value) || value.kind !== query)
		throw new TypeError('receipt request must match query');
	if (query === 'addFile' || query === 'exportedNames') {
		if (!hasExactKeys(value, ['file', 'kind']) || typeof value.file !== 'string')
			throw new TypeError(`invalid ${query} request`);
		return;
	}
	if (
		[
			'definitionOf',
			'referencesOf',
			'readsOf',
			'writesOf',
			'capturesOf',
			'reachableFrom',
			'reaches',
		].includes(query)
	) {
		if (!hasExactKeys(value, ['kind', 'target']) || !isAnchor(value.target))
			throw new TypeError(`invalid ${query} request`);
		return;
	}
	if (query === 'resolveBinding') {
		if (
			!hasExactKeys(value, ['file', 'kind', 'name', 'scope', 'space']) ||
			typeof value.file !== 'string' ||
			typeof value.name !== 'string' ||
			!['value', 'type', 'namespace', 'typeof', 'any'].includes(String(value.space)) ||
			(value.scope !== null && !isAnchor(value.scope))
		)
			throw new TypeError('invalid resolveBinding request');
		return;
	}
	if (query === 'safeChangeImpact') {
		if (
			!hasExactKeys(value, ['intent', 'kind', 'snapshot', 'target']) ||
			typeof value.snapshot !== 'string' ||
			!/^[a-f0-9]{64}$/.test(value.snapshot) ||
			!['rename', 'delete', 'entry-point'].includes(String(value.intent)) ||
			(!isAnchor(value.target) && !isSafeChangeBindingSelector(value.target))
		)
			throw new TypeError('invalid safeChangeImpact request');
		return;
	}
	throw new TypeError(`unknown receipt query '${query}'`);
}

function assertQueryResults(query: string, results: unknown[]): void {
	if (query === 'addFile') {
		if (results.length !== 0) throw new TypeError('addFile refusal cannot have results');
		return;
	}
	if (query === 'definitionOf' || query === 'resolveBinding') {
		if (results.length > 1 || !results.every(isAnchor))
			throw new TypeError(`${query} requires at most one anchor result`);
		return;
	}
	if (query === 'referencesOf' || query === 'readsOf' || query === 'writesOf') {
		for (const result of results) {
			if (
				!isRecord(result) ||
				!hasExactKeys(result, ['access', 'site']) ||
				!isAnchor(result.site) ||
				!['read', 'write', 'read-write'].includes(String(result.access))
			)
				throw new TypeError('invalid reference result');
			if (query === 'readsOf' && result.access === 'write')
				throw new TypeError('readsOf contains a write-only result');
			if (query === 'writesOf' && result.access === 'read')
				throw new TypeError('writesOf contains a read-only result');
		}
		return;
	}
	if (query === 'exportedNames') {
		for (const result of results)
			if (
				!isRecord(result) ||
				!hasExactKeys(result, ['module', 'name']) ||
				!isAnchor(result.module) ||
				typeof result.name !== 'string'
			)
				throw new TypeError('invalid export result');
		return;
	}
	if (query === 'capturesOf') {
		for (const result of results)
			if (
				!isRecord(result) ||
				!hasExactKeys(result, ['isWritten', 'references', 'symbol']) ||
				!isAnchor(result.symbol) ||
				!Array.isArray(result.references) ||
				!result.references.every(isAnchor) ||
				typeof result.isWritten !== 'boolean'
			)
				throw new TypeError('invalid capture result');
		return;
	}
	if (query === 'reachableFrom' || query === 'reaches') {
		const symbols = new Set<string>();
		for (const result of results) {
			if (
				!isRecord(result) ||
				!hasExactKeys(result, ['symbol', 'witness']) ||
				!isAnchor(result.symbol) ||
				!Array.isArray(result.witness) ||
				result.witness.length === 0 ||
				!result.witness.every(isAnchor)
			)
				throw new TypeError('invalid reachability result');
			const identity = canonicalize(result.symbol);
			if (symbols.has(identity)) throw new TypeError('duplicate reachability result');
			symbols.add(identity);
		}
		return;
	}
	if (query === 'safeChangeImpact') {
		const sites = new Set<string>();
		for (const result of results) {
			if (
				!isRecord(result) ||
				!hasExactKeys(result, ['roles', 'site', 'witness']) ||
				!isAnchor(result.site) ||
				!Array.isArray(result.roles) ||
				result.roles.length === 0 ||
				!result.roles.every(isSafeChangeRole) ||
				new Set(result.roles).size !== result.roles.length ||
				!Array.isArray(result.witness) ||
				!result.witness.every(isAnchor)
			)
				throw new TypeError('invalid safe-change impact result');
			const identity = canonicalize(result.site);
			if (sites.has(identity)) throw new TypeError('duplicate safe-change impact site');
			sites.add(identity);
		}
		return;
	}
	throw new TypeError(`unknown receipt query '${query}'`);
}

function assertUnresolved(value: unknown): void {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['detail', 'reason', 'site']) ||
		!isAnchor(value.site) ||
		!isReason(value.reason) ||
		typeof value.detail !== 'string'
	)
		throw new TypeError('invalid unresolved site');
}
function isReason(value: unknown): value is UnresolvedReason {
	return typeof value === 'string' && (UNRESOLVED_REASONS as readonly string[]).includes(value);
}
function isSafeChangeRole(value: unknown): value is SafeChangeRole {
	return typeof value === 'string' && (SAFE_CHANGE_ROLES as readonly string[]).includes(value);
}
function isSafeChangeBindingSelector(value: unknown): value is SafeChangeBindingSelector {
	if (!isRecord(value)) return false;
	const keys =
		value.from === undefined ? ['file', 'name', 'space'] : ['file', 'from', 'name', 'space'];
	return (
		hasExactKeys(value, keys) &&
		typeof value.file === 'string' &&
		typeof value.name === 'string' &&
		['value', 'type', 'namespace', 'typeof', 'any'].includes(String(value.space)) &&
		(value.from === undefined || isAnchor(value.from))
	);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

export function isAnchor(value: unknown): value is SymbolAnchor {
	if (!isRecord(value) || !hasExactKeys(value, anchorKeys)) return false;
	return (
		value.schema === 'guessless.symbol-anchor/v1' &&
		typeof value.file === 'string' &&
		Array.isArray(value.semanticPath) &&
		value.semanticPath.length > 0 &&
		value.semanticPath.every((part) => typeof part === 'string') &&
		typeof value.fingerprint === 'string' &&
		/^[a-f0-9]{64}$/.test(value.fingerprint)
	);
}

export function receiptCanonicalForm(receipt: Receipt<unknown>): string {
	return canonicalize(receipt);
}
