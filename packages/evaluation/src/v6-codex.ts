import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V6_BUDGETS, V6_POLICY, sha256, stableJson } from './v6-contracts.ts';
import { v6FixtureRoot } from './v6-corpus.ts';
import type { V6Cell } from './v6-preregistration.ts';

export interface V6TranscriptEvent {
	readonly type:
		| 'tool.started'
		| 'tool.cancelled'
		| 'tool.delivered'
		| 'proof.delivered'
		| 'turn.completed';
	readonly tool?: string;
	readonly applicable?: boolean;
	readonly reportedTokens?: number;
	readonly durationMs?: number;
	readonly failed?: boolean;
}

export interface V6DeliveryAccounting {
	readonly starts: number;
	readonly cancellations: number;
	readonly deliveredResults: number;
	readonly deliveredApplicablePrepare: number;
	readonly deliveredApplicableImpact: number;
	readonly proofReads: number;
	readonly toolCalls: number;
	readonly reportedTokens: number;
	readonly durationMs: number;
}

export function inspectV6Transcript(events: readonly V6TranscriptEvent[]): V6DeliveryAccounting {
	let starts = 0;
	let cancellations = 0;
	let deliveredResults = 0;
	let deliveredApplicablePrepare = 0;
	let deliveredApplicableImpact = 0;
	let proofReads = 0;
	let toolCalls = 0;
	let reportedTokens = 0;
	let durationMs = 0;
	let completed = 0;
	const pending = new Map<string, number>();
	for (const [index, event] of events.entries()) {
		if (completed > 0)
			throw new Error('v6 transcript contains an event after terminal completion');
		if (event.type === 'tool.started') {
			if (typeof event.tool !== 'string') throw new Error('v6 tool start lacks identity');
			starts += 1;
			toolCalls += 1;
			pending.set(event.tool, (pending.get(event.tool) ?? 0) + 1);
		}
		if (event.type === 'tool.cancelled') {
			if (typeof event.tool !== 'string' || (pending.get(event.tool) ?? 0) < 1)
				throw new Error('v6 cancellation lacks matching tool start');
			pending.set(event.tool, pending.get(event.tool)! - 1);
			cancellations += 1;
		}
		if (event.type === 'tool.delivered') {
			if (typeof event.tool !== 'string' || (pending.get(event.tool) ?? 0) < 1)
				throw new Error('v6 delivery lacks matching tool start');
			pending.set(event.tool, pending.get(event.tool)! - 1);
			deliveredResults += 1;
			if (event.applicable && event.tool === 'guessless_prepare_snapshot')
				deliveredApplicablePrepare += 1;
			if (event.applicable && event.tool === 'guessless_safe_change_impact')
				deliveredApplicableImpact += 1;
		}
		if (event.type === 'proof.delivered') {
			if (typeof event.tool !== 'string' || (pending.get(event.tool) ?? 0) < 1)
				throw new Error('v6 proof delivery lacks matching tool start');
			pending.set(event.tool, pending.get(event.tool)! - 1);
			proofReads += 1;
		}
		if (event.type === 'turn.completed') {
			completed += 1;
			reportedTokens = Number(event.reportedTokens);
			durationMs = Number(event.durationMs);
		}
		if (event.type === 'turn.completed' && index !== events.length - 1)
			throw new Error('v6 terminal completion must be final');
	}
	if (completed !== 1) throw new Error('v6 transcript requires exactly one completed turn');
	if ([...pending.values()].some((count) => count !== 0))
		throw new Error('v6 transcript contains an unmatched tool start');
	for (const [label, value, maximum] of [
		['tools', toolCalls, V6_BUDGETS.perCell.maxToolCalls],
		['tokens', reportedTokens, V6_BUDGETS.perCell.maxReportedTokens],
		['duration', durationMs, V6_BUDGETS.perCell.timeoutMs],
	] as const)
		if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
			throw new Error(`v6 ${label} budget exceeded`);
	return {
		starts,
		cancellations,
		deliveredResults,
		deliveredApplicablePrepare,
		deliveredApplicableImpact,
		proofReads,
		toolCalls,
		reportedTokens,
		durationMs,
	};
}

export function assertV6AggregateBudget(accounting: readonly V6DeliveryAccounting[]): void {
	const total = (field: 'toolCalls' | 'reportedTokens' | 'durationMs') =>
		accounting.reduce((sum, item) => sum + item[field], 0);
	if (total('toolCalls') > V6_BUDGETS.aggregate.maxToolCalls)
		throw new Error('v6 aggregate tool budget exceeded');
	if (total('reportedTokens') > V6_BUDGETS.aggregate.maxReportedTokens)
		throw new Error('v6 aggregate token budget exceeded');
	if (total('durationMs') > V6_BUDGETS.aggregate.maxDurationMs)
		throw new Error('v6 aggregate duration budget exceeded');
}

export interface V6SealedReplay {
	readonly schema: 'guessless.v6-sealed-replay/v1';
	readonly outcome: 'complete' | 'partial-NO_GO';
	readonly records: readonly {
		readonly cellId: string;
		readonly status: 'completed' | 'unrun';
		readonly events: readonly V6TranscriptEvent[];
		readonly accounting: V6DeliveryAccounting | null;
		readonly reason?: 'completion-impossible';
	}[];
	readonly integrity: string;
}

export type V6InjectedSpawner = (cell: V6Cell) => readonly V6TranscriptEvent[];

export function recordAndSealV6(
	order: readonly V6Cell[],
	spawner: V6InjectedSpawner,
): V6SealedReplay {
	if (
		order.length !== V6_POLICY.cellCount ||
		new Set(order.map((cell) => cell.id)).size !== order.length
	)
		throw new Error('v6 recorder requires 72 unique frozen cells');
	const records = order.map((cell, index) => {
		if (cell.ordinal !== index + 1) throw new Error('v6 recorder order identity mismatch');
		const events = [...spawner(cell)];
		return {
			cellId: cell.id,
			status: 'completed' as const,
			events,
			accounting: inspectV6Transcript(events),
		};
	});
	assertV6AggregateBudget(records.map((record) => record.accounting));
	const unsigned = {
		schema: 'guessless.v6-sealed-replay/v1' as const,
		outcome: 'complete' as const,
		records,
	};
	return { ...unsigned, integrity: sha256(stableJson(unsigned)) };
}

export function recordFirstFailureAndSealV6(
	order: readonly V6Cell[],
	spawner: V6InjectedSpawner,
): V6SealedReplay {
	if (
		order.length !== V6_POLICY.cellCount ||
		new Set(order.map((cell) => cell.id)).size !== order.length
	)
		throw new Error('v6 failure recorder requires 72 unique frozen cells');
	const first = order[0];
	if (first === undefined || first.ordinal !== 1)
		throw new Error('v6 failure recorder order mismatch');
	const events = [...spawner(first)];
	if (events.at(-1)?.type !== 'turn.completed' || events.at(-1)?.failed !== true)
		throw new Error('v6 injected first cell did not fail');
	const accounting = inspectV6Transcript(events);
	const records: V6SealedReplay['records'] = [
		{ cellId: first.id, status: 'completed', events, accounting },
		...order.slice(1).map((cell, index) => {
			if (cell.ordinal !== index + 2)
				throw new Error('v6 failure recorder order identity mismatch');
			return {
				cellId: cell.id,
				status: 'unrun' as const,
				events: [],
				accounting: null,
				reason: 'completion-impossible' as const,
			};
		}),
	];
	assertV6AggregateBudget([accounting]);
	const unsigned = {
		schema: 'guessless.v6-sealed-replay/v1' as const,
		outcome: 'partial-NO_GO' as const,
		records,
	};
	return { ...unsigned, integrity: sha256(stableJson(unsigned)) };
}

export function verifyV6Replay(order: readonly V6Cell[], replay: V6SealedReplay): void {
	const { integrity, ...unsigned } = replay;
	if (integrity !== sha256(stableJson(unsigned)) || replay.records.length !== order.length)
		throw new Error('v6 replay integrity mismatch');
	const accounting: V6DeliveryAccounting[] = [];
	for (const [index, record] of replay.records.entries()) {
		if (record.cellId !== order[index]?.id) throw new Error('v6 replay cell identity mismatch');
		if (record.status === 'unrun') {
			if (
				replay.outcome !== 'partial-NO_GO' ||
				index === 0 ||
				record.events.length !== 0 ||
				record.accounting !== null ||
				record.reason !== 'completion-impossible'
			)
				throw new Error('v6 replay unrun record mismatch');
			continue;
		}
		if (record.accounting === null || record.reason !== undefined)
			throw new Error('v6 replay completed record mismatch');
		const inspected = inspectV6Transcript(record.events);
		if (stableJson(inspected) !== stableJson(record.accounting))
			throw new Error('v6 replay accounting mismatch');
		accounting.push(inspected);
	}
	if (
		(replay.outcome === 'complete' &&
			replay.records.some((record) => record.status !== 'completed')) ||
		(replay.outcome === 'partial-NO_GO' &&
			(replay.records[0]?.status !== 'completed' ||
				replay.records[0].events.at(-1)?.failed !== true ||
				replay.records.slice(1).some((record) => record.status !== 'unrun')))
	)
		throw new Error('v6 replay outcome topology mismatch');
	assertV6AggregateBudget(accounting);
}

export interface FakePreflightResult {
	readonly schema: 'guessless.v6-fake-preflight/v1';
	readonly cells: number;
	readonly spawnedModelCells: 0;
	readonly attemptedCells: 1;
	readonly unrunCells: 71;
	readonly stoppedAfterFirstFailure: true;
	readonly environment: readonly string[];
	readonly integrityChecks: readonly string[];
}

function fakeFailureEvents(): V6TranscriptEvent[] {
	return [{ type: 'turn.completed', reportedTokens: 10, durationMs: 1, failed: true }];
}

export function generateFakeV6Replay(order: readonly V6Cell[]): V6SealedReplay {
	return recordFirstFailureAndSealV6(order, fakeFailureEvents);
}

export function runFakeOnlyPreflight(moduleUrl = import.meta.url): FakePreflightResult {
	const fixtureRoot = v6FixtureRoot(moduleUrl);
	const order = JSON.parse(readFileSync(join(fixtureRoot, 'order.json'), 'utf8')) as V6Cell[];
	if (order.length !== V6_POLICY.cellCount) throw new Error('fake preflight order mismatch');
	let spawnerCalls = 0;
	const replay = recordFirstFailureAndSealV6(order, () => {
		spawnerCalls += 1;
		if (spawnerCalls > 1) throw new Error('v6 fake spawner called after first failure');
		return fakeFailureEvents();
	});
	verifyV6Replay(order, replay);
	const unrunCells = replay.records.filter((record) => record.status === 'unrun').length;
	if (spawnerCalls !== 1 || unrunCells !== 71 || replay.outcome !== 'partial-NO_GO')
		throw new Error('first-cell completion stop is not mechanical');
	return {
		schema: 'guessless.v6-fake-preflight/v1',
		cells: order.length,
		spawnedModelCells: 0,
		attemptedCells: 1,
		unrunCells: 71,
		stoppedAfterFirstFailure: true,
		environment: [
			'HOME=fresh-empty-directory',
			'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
			'LANG=C.UTF-8',
			'TMPDIR=fresh-cell-directory',
			'network=disabled',
			'sandbox=read-only',
			'user-config=ignored',
			'user-rules=ignored',
		],
		integrityChecks: [
			'fake-spawner-only',
			'no calibration path',
			'no retry/replacement/rescore path',
			'delivery differs from start/cancellation',
			'proof reads counted as tools/tokens/time',
		],
	};
}
