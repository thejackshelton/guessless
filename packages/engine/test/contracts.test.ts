import { describe, expect, test } from 'vitest';
import {
	makeReceipt,
	makeSafeChangeSummary,
	UNRESOLVED_REASONS,
	verifyReceipt,
	verifySafeChangeSummary,
} from '../src/index.ts';

const snapshot = '0'.repeat(64);

describe('receipt contract', () => {
	test('has exactly the ruled closed reason set', () => {
		// 15 original reasons plus 'unlinked-input', ruled in for D1: a supplied
		// input whose own specifier failed to link to another supplied input;
		// plus 'method-call-mutation-uncertain', ruled in for D3: a call on a
		// member of the queried binding, which may or may not mutate it.
		// No existing member was removed, renamed, or widened.
		expect(UNRESOLVED_REASONS).toHaveLength(17);
		expect(UNRESOLVED_REASONS).toContain('higher-order-call-boundary');
		expect(UNRESOLVED_REASONS).toContain('stale-snapshot');
		expect(UNRESOLVED_REASONS).toContain('unlinked-input');
		expect(UNRESOLVED_REASONS).toContain('method-call-mutation-uncertain');
		// The uncertainty reason is additional to, not a replacement for, the
		// reason that names an observed mutation behind an alias.
		expect(UNRESOLVED_REASONS).toContain('property-alias-write-uncertain');
		expect(UNRESOLVED_REASONS).not.toContain('other');
	});

	test('enforces exact mutually exclusive state schemas', () => {
		expect(verifyReceipt([])).toBe(false);
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'exportedNames',
				request: { kind: 'exportedNames', file: 'a.ts' },
				snapshot,
				results: [],
				unresolved: [],
			} as never),
		).toThrow('cross-state');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'partial',
				query: 'exportedNames',
				request: { kind: 'exportedNames', file: 'a.ts' },
				snapshot,
				results: [],
				unresolved: [
					{
						site: {
							schema: 'guessless.symbol-anchor/v1',
							file: 'a.ts',
							semanticPath: ['module:x'],
							fingerprint: snapshot,
						},
						reason: 'unresolved-symbol',
						detail: 'gap',
					},
				],
				reason: 'unresolved-symbol',
				detail: 'refused fields',
			} as never),
		).toThrow('cross-state');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'refused',
				query: 'exportedNames',
				request: { kind: 'exportedNames', file: 'a.ts' },
				snapshot,
				results: ['forbidden'],
				reason: 'unresolved-symbol',
				detail: 'no',
			} as never),
		).toThrow();
	});

	test('validates results by query', () => {
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'referencesOf',
				request: {
					kind: 'referencesOf',
					target: {
						schema: 'guessless.symbol-anchor/v1',
						file: 'a.ts',
						semanticPath: ['symbol:x'],
						fingerprint: snapshot,
					},
				},
				snapshot,
				results: [{ site: 'not-an-anchor', access: 'read' }],
			} as never),
		).toThrow('reference result');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'writesOf',
				request: {
					kind: 'writesOf',
					target: {
						schema: 'guessless.symbol-anchor/v1',
						file: 'a.ts',
						semanticPath: ['symbol:x'],
						fingerprint: snapshot,
					},
				},
				snapshot,
				results: [
					{
						site: {
							schema: 'guessless.symbol-anchor/v1',
							file: 'a.ts',
							semanticPath: ['site:x'],
							fingerprint: snapshot,
						},
						access: 'read',
					},
				],
			} as never),
		).toThrow('read-only');
	});

	test('detects integrity and snapshot tampering', () => {
		const receipt = makeReceipt({
			schema: 'guessless.receipt/v1',
			state: 'complete',
			query: 'exportedNames',
			request: { kind: 'exportedNames', file: 'a.ts' },
			snapshot,
			results: [],
		});
		expect(verifyReceipt(receipt, snapshot)).toBe(true);
		expect(verifyReceipt({ ...receipt, snapshot: '1'.repeat(64) }, '1'.repeat(64))).toBe(false);
		expect(verifyReceipt(receipt, '1'.repeat(64))).toBe(false);
	});

	test('requires exact query-specific request schemas', () => {
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'exportedNames',
				request: { kind: 'exportedNames', file: 'a.ts', target: null },
				snapshot,
				results: [],
			} as never),
		).toThrow('request');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'referencesOf',
				request: { kind: 'writesOf', target: null },
				snapshot,
				results: [],
			} as never),
		).toThrow('match query');
	});

	test('runtime-validates signed reachability requests and witness results', () => {
		const target = {
			schema: 'guessless.symbol-anchor/v1' as const,
			file: 'entry.ts',
			semanticPath: ['symbol:entry'],
			fingerprint: snapshot,
		};
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'reachableFrom',
				request: { kind: 'reaches', target },
				snapshot,
				results: [],
			} as never),
		).toThrow('match query');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'reaches',
				request: { kind: 'reaches', target },
				snapshot,
				results: [{ symbol: target, witness: [] }],
			} as never),
		).toThrow('reachability result');
		expect(() =>
			makeReceipt({
				schema: 'guessless.receipt/v1',
				state: 'complete',
				query: 'reaches',
				request: { kind: 'reaches', target },
				snapshot,
				results: [
					{ symbol: target, witness: [target] },
					{ symbol: target, witness: [target] },
				],
			} as never),
		).toThrow('duplicate reachability');
	});

	test('strictly validates integrity-bound safe-change requests, roles, and unique sites', () => {
		const target = {
			schema: 'guessless.symbol-anchor/v1' as const,
			file: 'entry.ts',
			semanticPath: ['symbol:entry'],
			fingerprint: snapshot,
		};
		const request = {
			kind: 'safeChangeImpact' as const,
			snapshot,
			intent: 'rename' as const,
			target,
		};
		const receipt = makeReceipt({
			schema: 'guessless.receipt/v1',
			state: 'complete',
			query: 'safeChangeImpact',
			request,
			snapshot,
			results: [{ site: target, roles: ['declaration'] as const, witness: [] }],
		});
		expect(verifyReceipt(receipt, snapshot)).toBe(true);
		expect(verifyReceipt({ ...receipt, results: [] }, snapshot)).toBe(false);
		expect(() =>
			makeReceipt({
				...receipt,
				results: [{ site: target, roles: [], witness: [] }],
			} as never),
		).toThrow('safe-change');
		expect(() =>
			makeReceipt({
				...receipt,
				results: [
					{ site: target, roles: ['declaration'], witness: [] },
					{ site: target, roles: ['reference'], witness: [] },
				],
			} as never),
		).toThrow('duplicate safe-change');
		expect(() =>
			makeReceipt({
				...receipt,
				request: { ...request, extra: true },
			} as never),
		).toThrow('safeChangeImpact request');
		expect(() =>
			makeReceipt({
				...receipt,
				results: [{ site: target, roles: ['declaration'], witness: [], extra: true }],
			} as never),
		).toThrow('safe-change');
	});

	test('strictly validates integrity-bound progressive safe-change summaries', () => {
		const target = {
			schema: 'guessless.symbol-anchor/v1' as const,
			file: 'entry.ts',
			semanticPath: ['symbol:entry'],
			fingerprint: snapshot,
		};
		const full = makeReceipt({
			schema: 'guessless.receipt/v1',
			state: 'complete',
			query: 'safeChangeImpact',
			request: { kind: 'safeChangeImpact', snapshot, intent: 'rename', target },
			snapshot,
			results: [{ site: target, roles: ['declaration'] as const, witness: [] }],
		});
		const summary = makeSafeChangeSummary(full);
		expect(verifySafeChangeSummary(summary)).toBe(true);
		expect(verifySafeChangeSummary({ ...summary, counts: { results: 0, unresolved: 0 } })).toBe(
			false,
		);
		expect(verifySafeChangeSummary({ ...summary, proofHandle: '1'.repeat(64) })).toBe(false);
	});
});
