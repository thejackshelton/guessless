import { createHash } from 'node:crypto';
import type { Analyzer } from 'yuku-analyzer';
import {
	isAnchor,
	SAFE_CHANGE_ROLES,
	UNRESOLVED_REASONS,
	verifyReceipt,
	type QueryRequest,
	type Receipt,
	type SafeChangeImpactResult,
	type SafeChangeIntent,
	type SafeChangeRole,
	type SafeChangeTarget,
	type UnresolvedReason,
} from './contracts.ts';
import { safeChangeImpact } from './safe-change.ts';

export interface CompactSiteIdentity {
	readonly id: string;
	readonly file: string;
	readonly label: string;
}

export interface SafeChangeSummaryResult {
	readonly site: number;
	readonly roles: readonly SafeChangeRole[];
}

export interface SafeChangeSummaryUnresolved {
	readonly site: number;
	readonly reason: UnresolvedReason;
}

interface SafeChangeSummaryBase {
	readonly schema: 'guessless.safe-change-summary/v1';
	readonly request: Extract<QueryRequest, { kind: 'safeChangeImpact' }>;
	readonly snapshot: string;
	readonly state: 'complete' | 'partial' | 'refused';
	readonly sites: readonly CompactSiteIdentity[];
	readonly results: readonly SafeChangeSummaryResult[];
	readonly unresolved: readonly SafeChangeSummaryUnresolved[];
	readonly proofHandle: string;
	readonly counts: {
		readonly sites: number;
		readonly results: number;
		readonly unresolved: number;
	};
	readonly integrity: string;
}

export interface CompleteSafeChangeSummary extends SafeChangeSummaryBase {
	readonly state: 'complete';
}
export interface PartialSafeChangeSummary extends SafeChangeSummaryBase {
	readonly state: 'partial';
}
export interface RefusedSafeChangeSummary extends SafeChangeSummaryBase {
	readonly state: 'refused';
	readonly reason: UnresolvedReason;
	readonly detail: string;
}
export type SafeChangeSummary =
	| CompleteSafeChangeSummary
	| PartialSafeChangeSummary
	| RefusedSafeChangeSummary;

function semanticLabel(semanticPath: readonly string[]): string {
	let site: string | undefined;
	let module: string | undefined;
	for (const part of semanticPath) {
		if (part.startsWith('symbol:')) return part;
		if (site === undefined && part.startsWith('site:')) site = part;
		if (module === undefined && part.startsWith('module:')) module = part;
	}
	return site ?? module ?? semanticPath[0]!;
}

export function makeSafeChangeSummary(receipt: Receipt<SafeChangeImpactResult>): SafeChangeSummary {
	if (!verifyReceipt(receipt) || receipt.query !== 'safeChangeImpact')
		throw new TypeError('safe-change summary requires one valid full safeChangeImpact receipt');
	return projectSafeChangeSummary(receipt);
}

function siteIdentity(site: SafeChangeImpactResult['site']): string {
	return createHash('sha256')
		.update(JSON.stringify([site.file, site.semanticPath, site.fingerprint]))
		.digest('hex');
}

function summaryIntegrity(value: Omit<SafeChangeSummary, 'integrity'>): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectSafeChangeSummary(receipt: Receipt<SafeChangeImpactResult>): SafeChangeSummary {
	const request = receipt.request as Extract<QueryRequest, { kind: 'safeChangeImpact' }>;
	const sites: CompactSiteIdentity[] = [];
	const ordinals = new Map<string, number>();
	const addSite = (site: SafeChangeImpactResult['site'], id = siteIdentity(site)): number => {
		const ordinal = sites.length;
		ordinals.set(id, ordinal);
		sites.push({ id, file: site.file, label: semanticLabel(site.semanticPath) });
		return ordinal;
	};
	const results: SafeChangeSummaryResult[] = [];
	for (const result of receipt.results)
		results.push({ site: addSite(result.site), roles: result.roles });
	const unresolved: SafeChangeSummaryUnresolved[] = [];
	if (receipt.state === 'partial')
		for (const item of receipt.unresolved) {
			const id = siteIdentity(item.site);
			const site = ordinals.get(id) ?? addSite(item.site, id);
			unresolved.push({ site, reason: item.reason });
		}
	const base = {
		schema: 'guessless.safe-change-summary/v1' as const,
		state: receipt.state,
		request,
		snapshot: receipt.snapshot,
		sites,
		results,
		unresolved,
		proofHandle: receipt.integrity,
		counts: { sites: sites.length, results: results.length, unresolved: unresolved.length },
	};
	const unsigned =
		receipt.state === 'refused'
			? { ...base, reason: receipt.reason, detail: receipt.detail }
			: base;
	return { ...unsigned, integrity: summaryIntegrity(unsigned) } as SafeChangeSummary;
}

export function safeChangeImpactSummary(
	analyzer: Analyzer,
	snapshot: string,
	intent: SafeChangeIntent,
	target: SafeChangeTarget,
): { receipt: Receipt<SafeChangeImpactResult>; summary: SafeChangeSummary } {
	const receipt = safeChangeImpact(analyzer, snapshot, intent, target);
	return { receipt, summary: projectSafeChangeSummary(receipt) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validSelector(value: unknown): value is SafeChangeTarget {
	if (!isRecord(value)) return false;
	const keys =
		value.from === undefined ? ['file', 'name', 'space'] : ['file', 'from', 'name', 'space'];
	return (
		exactKeys(value, keys) &&
		typeof value.file === 'string' &&
		typeof value.name === 'string' &&
		['value', 'type', 'namespace', 'typeof', 'any'].includes(String(value.space)) &&
		(value.from === undefined || isAnchor(value.from))
	);
}

function validRequest(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, ['intent', 'kind', 'snapshot', 'target']) &&
		value.kind === 'safeChangeImpact' &&
		typeof value.snapshot === 'string' &&
		/^[a-f0-9]{64}$/.test(value.snapshot) &&
		['rename', 'delete', 'entry-point'].includes(String(value.intent)) &&
		(isAnchor(value.target) || validSelector(value.target))
	);
}

export function verifySafeChangeSummary(value: unknown): value is SafeChangeSummary {
	if (!isRecord(value)) return false;
	const state = value.state;
	const keys = [
		'counts',
		'integrity',
		'proofHandle',
		'request',
		'results',
		'schema',
		'sites',
		'snapshot',
		'state',
		'unresolved',
		...(state === 'refused' ? ['detail', 'reason'] : []),
	];
	if (
		!exactKeys(value, keys) ||
		value.schema !== 'guessless.safe-change-summary/v1' ||
		!['complete', 'partial', 'refused'].includes(String(state)) ||
		typeof value.snapshot !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.snapshot) ||
		!validRequest(value.request) ||
		typeof value.proofHandle !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.proofHandle) ||
		typeof value.integrity !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.integrity) ||
		!Array.isArray(value.sites) ||
		!Array.isArray(value.results) ||
		!Array.isArray(value.unresolved) ||
		!isRecord(value.counts)
	)
		return false;
	const sites = value.sites;
	const request = value.request as Extract<QueryRequest, { kind: 'safeChangeImpact' }>;
	const siteIds = new Set<string>();
	for (const site of sites) {
		if (
			!isRecord(site) ||
			!exactKeys(site, ['file', 'id', 'label']) ||
			typeof site.id !== 'string' ||
			!/^[a-f0-9]{64}$/.test(site.id) ||
			typeof site.file !== 'string' ||
			typeof site.label !== 'string' ||
			site.label.length === 0 ||
			siteIds.has(site.id)
		)
			return false;
		siteIds.add(site.id);
	}
	const validOrdinal = (ordinal: unknown): ordinal is number =>
		Number.isSafeInteger(ordinal) && Number(ordinal) >= 0 && Number(ordinal) < sites.length;
	const resultSites = new Set<number>();
	for (const result of value.results) {
		const roles = isRecord(result) && Array.isArray(result.roles) ? result.roles : null;
		if (
			!isRecord(result) ||
			!exactKeys(result, ['roles', 'site']) ||
			!validOrdinal(result.site) ||
			roles === null ||
			roles.length === 0 ||
			!roles.every(
				(role, index) =>
					typeof role === 'string' &&
					SAFE_CHANGE_ROLES.includes(role as SafeChangeRole) &&
					(index === 0 ||
						SAFE_CHANGE_ROLES.indexOf(roles[index - 1] as SafeChangeRole) <
							SAFE_CHANGE_ROLES.indexOf(role as SafeChangeRole)),
			) ||
			resultSites.has(result.site)
		)
			return false;
		resultSites.add(result.site);
	}
	const unresolvedPairs = new Set<string>();
	for (const item of value.unresolved) {
		if (
			!isRecord(item) ||
			!exactKeys(item, ['reason', 'site']) ||
			!validOrdinal(item.site) ||
			typeof item.reason !== 'string' ||
			!UNRESOLVED_REASONS.includes(item.reason as UnresolvedReason) ||
			unresolvedPairs.has(`${item.site}:${item.reason}`)
		)
			return false;
		unresolvedPairs.add(`${item.site}:${item.reason}`);
	}
	if (
		!exactKeys(value.counts, ['results', 'sites', 'unresolved']) ||
		value.counts.sites !== sites.length ||
		value.counts.results !== value.results.length ||
		value.counts.unresolved !== value.unresolved.length ||
		(state === 'complete' && value.unresolved.length !== 0) ||
		(state === 'partial' && value.unresolved.length === 0) ||
		(state === 'refused' &&
			(sites.length !== 0 ||
				value.results.length !== 0 ||
				value.unresolved.length !== 0 ||
				typeof value.reason !== 'string' ||
				!UNRESOLVED_REASONS.includes(value.reason as UnresolvedReason) ||
				typeof value.detail !== 'string'))
	)
		return false;
	if (
		(state === 'refused' && value.reason === 'stale-snapshot') !==
		(request.snapshot !== value.snapshot)
	)
		return false;
	const referenced = new Set([
		...value.results.map((result) => (result as { site: number }).site),
		...value.unresolved.map((item) => (item as { site: number }).site),
	]);
	if (referenced.size !== sites.length) return false;
	const { integrity, ...unsigned } = value;
	return integrity === summaryIntegrity(unsigned as Omit<SafeChangeSummary, 'integrity'>);
}

function quoted(value: string): string {
	return JSON.stringify(value);
}

export function safeChangeSummaryText(summary: SafeChangeSummary): string {
	const target = JSON.stringify(summary.request.target);
	const sites = summary.sites
		.map((site, ordinal) => `${ordinal}:${site.id}:${quoted(site.file)}:${quoted(site.label)}`)
		.join(';');
	const results = summary.results
		.map((result) => `${result.site}[${result.roles.join(',')}]`)
		.join(';');
	const unresolved = summary.unresolved.map((item) => `${item.site}[${item.reason}]`).join(';');
	const refusal =
		summary.state === 'refused' ? ` refused=${summary.reason}:${quoted(summary.detail)}` : '';
	return `guessless.safe-change-summary/v1 state=${summary.state} request=safeChangeImpact/${summary.request.intent}/${target} requestedSnapshot=${summary.request.snapshot} currentSnapshot=${summary.snapshot} proof=${summary.proofHandle} counts=${summary.counts.sites}/${summary.counts.results}/${summary.counts.unresolved} sites=${sites} results=${results} unresolved=${unresolved}${refusal} integrity=${summary.integrity}`;
}
