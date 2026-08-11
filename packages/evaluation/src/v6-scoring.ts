import {
	V6_BUDGETS,
	V6_POLICY,
	V6_ROLES,
	V6_TASKS,
	V6_UNRESOLVED_REASONS,
	stableJson,
	type V6Intent,
} from './v6-contracts.ts';
import type { V6DeliveryAccounting } from './v6-codex.ts';

export interface V6Response {
	readonly state: 'complete' | 'partial' | 'refused';
	readonly resolved: readonly { readonly siteId: string; readonly roles: readonly string[] }[];
	readonly unresolved: readonly { readonly siteId: string; readonly reason: string }[];
	readonly reasoning: string;
}

export interface V6TruthShape {
	readonly task: { readonly id: string; readonly intent: V6Intent };
	readonly resolved: readonly { readonly id: string; readonly roles: readonly string[] }[];
	readonly unresolved: readonly { readonly id: string; readonly reason: string }[];
}

export function validateV6Response(value: unknown): V6Response {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('v6 response must be an object');
	const response = value as Record<string, unknown>;
	if (
		Object.keys(response).sort().join() !==
			['reasoning', 'resolved', 'state', 'unresolved'].join() ||
		!['complete', 'partial', 'refused'].includes(String(response.state)) ||
		!Array.isArray(response.resolved) ||
		!Array.isArray(response.unresolved) ||
		typeof response.reasoning !== 'string'
	)
		throw new Error('v6 response shape mismatch');
	const resolvedIds = new Set<string>();
	for (const site of response.resolved) {
		if (
			site === null ||
			typeof site !== 'object' ||
			Array.isArray(site) ||
			Object.keys(site).sort().join() !== ['roles', 'siteId'].join() ||
			typeof site.siteId !== 'string' ||
			!Array.isArray(site.roles) ||
			site.roles.length === 0 ||
			!site.roles.every((role: unknown) => (V6_ROLES as readonly unknown[]).includes(role)) ||
			stableJson(site.roles) !==
				stableJson(V6_ROLES.filter((role) => site.roles.includes(role))) ||
			new Set(site.roles).size !== site.roles.length ||
			resolvedIds.has(site.siteId)
		)
			throw new Error('v6 resolved site invalid');
		resolvedIds.add(site.siteId);
	}
	const unresolvedIds = new Set<string>();
	for (const site of response.unresolved) {
		if (
			site === null ||
			typeof site !== 'object' ||
			Array.isArray(site) ||
			Object.keys(site).sort().join() !== ['reason', 'siteId'].join() ||
			typeof site.siteId !== 'string' ||
			!(V6_UNRESOLVED_REASONS as readonly unknown[]).includes(site.reason) ||
			unresolvedIds.has(site.siteId) ||
			resolvedIds.has(site.siteId)
		)
			throw new Error('v6 unresolved site invalid or overlaps resolved truth');
		unresolvedIds.add(site.siteId);
	}
	if (response.state === 'complete' && unresolvedIds.size > 0)
		throw new Error('v6 complete response contains unresolved sites');
	return response as unknown as V6Response;
}

export interface V6CellScore {
	readonly correct: boolean;
	readonly falseComplete: boolean;
	readonly missedResolved: readonly string[];
	readonly missedUnresolved: readonly string[];
	readonly falsePositiveResolved: readonly string[];
	readonly falsePositiveUnresolved: readonly string[];
	readonly coordinateRoleErrors: number;
}

export function scoreV6Response(truth: V6TruthShape, responseValue: unknown): V6CellScore {
	const response = validateV6Response(responseValue);
	const expectedResolved = new Map(truth.resolved.map((site) => [site.id, site.roles]));
	const expectedUnresolved = new Map(truth.unresolved.map((site) => [site.id, site.reason]));
	const reportedResolved = new Map(response.resolved.map((site) => [site.siteId, site.roles]));
	const reportedUnresolved = new Map(
		response.unresolved.map((site) => [site.siteId, site.reason]),
	);
	const missedResolved = [...expectedResolved.keys()].filter((id) => !reportedResolved.has(id));
	const missedUnresolved = [...expectedUnresolved.keys()].filter(
		(id) => !reportedUnresolved.has(id),
	);
	const falsePositiveResolved = [...reportedResolved.keys()].filter(
		(id) => !expectedResolved.has(id),
	);
	const falsePositiveUnresolved = [...reportedUnresolved.keys()].filter(
		(id) => !expectedUnresolved.has(id),
	);
	let coordinateRoleErrors = 0;
	for (const [id, roles] of reportedResolved)
		if (
			expectedResolved.has(id) &&
			JSON.stringify(roles) !== JSON.stringify(expectedResolved.get(id))
		)
			coordinateRoleErrors += 1;
	for (const [id, reason] of reportedUnresolved)
		if (expectedUnresolved.has(id) && reason !== expectedUnresolved.get(id))
			coordinateRoleErrors += 1;
	const falseComplete =
		response.state === 'complete' &&
		(missedResolved.length > 0 || missedUnresolved.length > 0 || truth.unresolved.length > 0);
	const correct =
		!falseComplete &&
		missedResolved.length === 0 &&
		missedUnresolved.length === 0 &&
		falsePositiveResolved.length === 0 &&
		falsePositiveUnresolved.length === 0 &&
		coordinateRoleErrors === 0 &&
		response.state === (truth.unresolved.length === 0 ? 'complete' : 'partial');
	return {
		correct,
		falseComplete,
		missedResolved,
		missedUnresolved,
		falsePositiveResolved,
		falsePositiveUnresolved,
		coordinateRoleErrors,
	};
}

function choose(n: number, k: number): number {
	let result = 1;
	for (let index = 1; index <= k; index += 1) result = (result * (n - index + 1)) / index;
	return result;
}

export function oneSidedExactP(wins: number, losses: number): number {
	const n = wins + losses;
	if (n === 0) return 1;
	let numerator = 0;
	for (let value = wins; value <= n; value += 1) numerator += choose(n, value);
	return numerator / 2 ** n;
}

export interface V6RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: V6Intent;
	readonly kind: 'consumption' | 'discovery';
	readonly arm: 'full' | 'summary' | 'control' | 'production';
	readonly score: V6CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
}

function expectedCells(): {
	id: string;
	taskId: string;
	intent: V6Intent;
	kind: V6RecordedCell['kind'];
	arm: V6RecordedCell['arm'];
}[] {
	const cells: ReturnType<typeof expectedCells> = [];
	for (const [index, task] of V6_TASKS.entries()) {
		const consumption =
			index % 2 === 0 ? (['full', 'summary'] as const) : (['summary', 'full'] as const);
		const discovery =
			index % 2 === 0
				? (['control', 'production'] as const)
				: (['production', 'control'] as const);
		for (const arm of consumption)
			cells.push({
				id: `v6-${String(cells.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				intent: task.intent,
				kind: 'consumption',
				arm,
			});
		for (const arm of discovery)
			cells.push({
				id: `v6-${String(cells.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				intent: task.intent,
				kind: 'discovery',
				arm,
			});
	}
	return cells;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	if (sorted.length === 0) return Number.NaN;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function decideV6(cells: readonly V6RecordedCell[]): {
	decision: 'GO' | 'NO_GO';
	gates: Record<string, boolean>;
	metrics: Record<string, number>;
} {
	const completed = cells.length;
	const expected = expectedCells();
	const exactCellIdentity =
		cells.length === expected.length &&
		cells.every((cell, index) => {
			const wanted = expected[index];
			return (
				wanted !== undefined &&
				cell.id === wanted.id &&
				cell.taskId === wanted.taskId &&
				cell.intent === wanted.intent &&
				cell.kind === wanted.kind &&
				cell.arm === wanted.arm
			);
		});
	const discovery = cells.filter((cell) => cell.kind === 'discovery');
	const production = discovery.filter((cell) => cell.arm === 'production');
	const control = discovery.filter((cell) => cell.arm === 'control');
	const consumption = cells.filter((cell) => cell.kind === 'consumption');
	const full = consumption.filter((cell) => cell.arm === 'full');
	const summary = consumption.filter((cell) => cell.arm === 'summary');
	const byTask = (items: readonly V6RecordedCell[]) =>
		new Map(items.map((cell) => [cell.taskId, cell]));
	const controlByTask = byTask(control);
	const fullByTask = byTask(full);
	let wins = 0;
	let losses = 0;
	let addedFalseCompleteness = 0;
	let taskRegression = false;
	for (const cell of production) {
		const paired = controlByTask.get(cell.taskId);
		if (paired === undefined) continue;
		if (cell.score.correct && !paired.score.correct) wins += 1;
		if (!cell.score.correct && paired.score.correct) losses += 1;
		if (cell.score.falseComplete && !paired.score.falseComplete) addedFalseCompleteness += 1;
	}
	for (const intent of ['rename', 'delete', 'entry-point'] as const) {
		const productionCorrect = production.filter(
			(cell) => cell.intent === intent && cell.score.correct,
		).length;
		const controlCorrect = control.filter(
			(cell) => cell.intent === intent && cell.score.correct,
		).length;
		if (productionCorrect < controlCorrect) taskRegression = true;
	}
	const selection = production.filter(
		(cell) =>
			cell.delivery.deliveredApplicablePrepare >= 1 &&
			cell.delivery.deliveredApplicableImpact >= 1,
	).length;
	const progressivePairs = summary.map((cell) => [fullByTask.get(cell.taskId), cell] as const);
	const progressiveQuality = progressivePairs.every(
		([fullCell, summaryCell]) =>
			fullCell !== undefined &&
			stableJson(fullCell.score) === stableJson(summaryCell.score) &&
			summaryCell.score.coordinateRoleErrors === 0 &&
			summaryCell.score.missedUnresolved.length === 0 &&
			summaryCell.score.falsePositiveUnresolved.length === 0,
	);
	const sum = (items: readonly V6RecordedCell[], field: 'initialBytes') =>
		items.reduce((total, item) => total + item[field], 0);
	const sumDelivery = (
		items: readonly V6RecordedCell[],
		field: 'toolCalls' | 'reportedTokens' | 'durationMs',
	) => items.reduce((total, item) => total + item.delivery[field], 0);
	const progressiveByteReduction = 1 - sum(summary, 'initialBytes') / sum(full, 'initialBytes');
	const progressiveTokenReduction =
		1 - sumDelivery(summary, 'reportedTokens') / sumDelivery(full, 'reportedTokens');
	const durationReduction =
		1 - sumDelivery(production, 'durationMs') / sumDelivery(control, 'durationMs');
	const toolReduction =
		1 - sumDelivery(production, 'toolCalls') / sumDelivery(control, 'toolCalls');
	const p = oneSidedExactP(wins, losses);
	const aggregateTools = sumDelivery(cells, 'toolCalls');
	const aggregateTokens = sumDelivery(cells, 'reportedTokens');
	const aggregateDuration = sumDelivery(cells, 'durationMs');
	const progressiveLatencyRegression =
		sumDelivery(summary, 'durationMs') <= sumDelivery(full, 'durationMs');
	const progressiveMedianCalls =
		median(summary.map((cell) => cell.delivery.toolCalls)) <=
		median(full.map((cell) => cell.delivery.toolCalls));
	const gates = {
		completion: completed === V6_POLICY.cellCount && exactCellIdentity,
		selection:
			production.length === V6_POLICY.naturalSelectionDenominator &&
			selection >= V6_POLICY.naturalSelectionMinimum,
		callBudget:
			cells.every(
				(cell) =>
					cell.semanticCalls <= 2 &&
					cell.warmSemanticCalls <= 1 &&
					cell.delivery.toolCalls <= V6_BUDGETS.perCell.maxToolCalls &&
					cell.delivery.reportedTokens <= V6_BUDGETS.perCell.maxReportedTokens &&
					cell.delivery.durationMs <= V6_BUDGETS.perCell.timeoutMs,
			) &&
			aggregateTools <= V6_BUDGETS.aggregate.maxToolCalls &&
			aggregateTokens <= V6_BUDGETS.aggregate.maxReportedTokens &&
			aggregateDuration <= V6_BUDGETS.aggregate.maxDurationMs,
		falseCompleteness: addedFalseCompleteness === 0,
		taskRegression: !taskRegression,
		correctness: wins - losses >= 4 && p <= 0.1,
		efficiency: durationReduction >= 0.2 || toolReduction >= 0.25,
		progressiveBytes: progressiveByteReduction >= 0.5,
		progressiveTokens: progressiveTokenReduction >= 0.25,
		progressiveQuality,
		progressiveCalls: progressiveMedianCalls,
		progressiveLatency: progressiveLatencyRegression,
	};
	return {
		decision: Object.values(gates).every(Boolean) ? 'GO' : 'NO_GO',
		gates,
		metrics: {
			completed,
			selection,
			wins,
			losses,
			oneSidedP: p,
			addedFalseCompleteness,
			progressiveByteReduction,
			progressiveTokenReduction,
			durationReduction,
			toolReduction,
			aggregateTools,
			aggregateTokens,
			aggregateDuration,
		},
	};
}
