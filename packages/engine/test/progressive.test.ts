import { describe, expect, test } from 'vitest';
import {
	GuesslessEngine,
	makeSafeChangeSummary,
	safeChangeSummaryText,
	verifySafeChangeSummary,
} from '../src/index.ts';

function engine(files: Record<string, string>): GuesslessEngine {
	const value = new GuesslessEngine();
	for (const [path, source] of Object.entries(files)) value.addFile(path, source);
	value.link();
	return value;
}

describe('safe-change progressive summary', () => {
	test('binds every complete result identity and ordered role while preserving the full receipt', () => {
		const value = engine({
			'core.ts': 'export let target = 1; target++;',
			'consumer.ts': "import { target as observed } from './core'; observed;",
		});
		const full = value.safeChangeImpact(
			value.snapshot(),
			'rename',
			value.anchor('core.ts', 'target')!,
		);
		const before = JSON.stringify(full);
		const summary = makeSafeChangeSummary(full);
		expect(summary).toMatchObject({
			schema: 'guessless.safe-change-summary/v1',
			state: 'complete',
			request: full.request,
			snapshot: full.snapshot,
			proofHandle: full.integrity,
			counts: { sites: full.results.length, results: full.results.length, unresolved: 0 },
		});
		expect(summary.sites).toEqual(
			full.results.map((result) =>
				expect.objectContaining({
					id: expect.stringMatching(/^[a-f0-9]{64}$/),
					file: result.site.file,
				}),
			),
		);
		expect(new Set(summary.sites.map((site) => site.id)).size).toBe(summary.sites.length);
		expect(summary.results).toEqual(
			full.results.map((result, site) => ({ site, roles: result.roles })),
		);
		expect(verifySafeChangeSummary(summary)).toBe(true);
		const text = safeChangeSummaryText(summary);
		expect(text).toContain(
			`request=safeChangeImpact/rename/${JSON.stringify(summary.request.target)}`,
		);
		expect(text).toContain(`requestedSnapshot=${summary.request.snapshot}`);
		expect(text).toContain(`currentSnapshot=${full.snapshot}`);
		expect(text).toContain(`proof=${full.integrity}`);
		for (const site of summary.sites) {
			expect(text).toContain(site.id);
			expect(text).toContain(JSON.stringify(site.file));
			expect(text).toContain(JSON.stringify(site.label));
		}
		for (const result of summary.results) expect(text).toContain(result.roles.join(','));
		expect(JSON.stringify(full)).toBe(before);
		expect(
			value.safeChangeImpact(value.snapshot(), 'rename', value.anchor('core.ts', 'target')!),
		).toEqual(full);
		const trusted = value.safeChangeImpactSummary(
			value.snapshot(),
			'rename',
			value.anchor('core.ts', 'target')!,
		);
		expect(trusted.receipt).toEqual(full);
		expect(trusted.summary).toEqual(summary);
		for (const forged of [
			{ ...summary, proofHandle: 'f'.repeat(64) },
			{
				...summary,
				sites: [
					{ ...summary.sites[0]!, label: 'symbol:forged' },
					...summary.sites.slice(1),
				],
			},
			{
				...summary,
				results: [
					{ ...summary.results[0]!, roles: ['reference'] as const },
					...summary.results.slice(1),
				],
			},
			{
				...summary,
				request: { ...summary.request, intent: 'delete' as const },
			},
		])
			expect(verifySafeChangeSummary(forged)).toBe(false);
	});

	test('retains every partial unresolved identity and closed reason without verbose detail', () => {
		const value = engine({
			'core.ts': 'export const target = 1;',
			'dynamic.ts':
				"import * as core from './core'; declare const key: string; core.target; core[key];",
		});
		const full = value.safeChangeImpact(
			value.snapshot(),
			'delete',
			value.anchor('core.ts', 'target')!,
		);
		expect(full.state).toBe('partial');
		if (full.state !== 'partial') return;
		const summary = makeSafeChangeSummary(full);
		expect(summary.state).toBe('partial');
		for (const item of summary.unresolved) {
			const site = summary.sites[item.site]!;
			expect(full.unresolved.some((candidate) => candidate.site.file === site.file)).toBe(
				true,
			);
			expect(full.unresolved.some((candidate) => candidate.reason === item.reason)).toBe(
				true,
			);
		}
		expect(JSON.stringify(summary)).not.toContain('detail');
		expect(verifySafeChangeSummary(summary)).toBe(true);
		expect(
			verifySafeChangeSummary({
				...summary,
				request: { ...summary.request, snapshot: '2'.repeat(64) },
			}),
		).toBe(false);
		expect(
			verifySafeChangeSummary({
				...summary,
				results: [{ ...summary.results[0], site: summary.sites.length }],
			}),
		).toBe(false);
	});

	test('rejects forged full receipt integrity before projection', () => {
		const value = engine({ 'core.ts': 'export const target = 1;' });
		const full = value.safeChangeImpact(value.snapshot(), 'rename', {
			file: 'core.ts',
			name: 'target',
			space: 'value',
		});
		expect(() => makeSafeChangeSummary({ ...full, integrity: '0'.repeat(64) })).toThrow(
			'valid full safeChangeImpact receipt',
		);
	});

	test('retains refused state, reason, detail, binding, handle, and integrity', () => {
		const value = engine({ 'core.ts': 'export const target = 1;' });
		const full = value.safeChangeImpact('1'.repeat(64), 'rename', {
			file: 'missing.ts',
			name: 'missing',
			space: 'value',
		});
		expect(full.state).toBe('refused');
		if (full.state !== 'refused') return;
		const summary = makeSafeChangeSummary(full);
		expect(summary).toMatchObject({
			state: 'refused',
			reason: full.reason,
			detail: full.detail,
			request: full.request,
			snapshot: full.snapshot,
			proofHandle: full.integrity,
			results: [],
			unresolved: [],
			sites: [],
			counts: { sites: 0, results: 0, unresolved: 0 },
		});
		expect(verifySafeChangeSummary(summary)).toBe(true);
		const text = safeChangeSummaryText(summary);
		expect(text).toContain(`requestedSnapshot=${summary.request.snapshot}`);
		expect(text).toContain(`currentSnapshot=${full.snapshot}`);
		expect(text).toContain(`refused=${full.reason}:${JSON.stringify(full.detail)}`);
		expect(verifySafeChangeSummary({ ...summary, reason: 'unresolved-symbol' })).toBe(false);
		expect(verifySafeChangeSummary({ ...summary, extra: true })).toBe(false);
	});
});
