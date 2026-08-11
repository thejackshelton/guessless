import type { GroundTruth } from './fixtures.ts';

export interface EvaluationResponse {
	readonly status: 'complete' | 'partial' | 'refused';
	readonly reportedSiteIds: readonly string[];
	readonly unresolvedSiteIds: readonly string[];
	readonly reasoning: string;
}

export interface CellScore {
	readonly task: keyof GroundTruth;
	readonly arm: 'control' | 'guessless';
	readonly planted: readonly string[];
	readonly reported: readonly string[];
	readonly sitesMissed: readonly string[];
	readonly falsePositives: readonly string[];
	readonly unresolved: readonly string[];
	readonly falseCompleteness: 0 | 1;
	readonly invalid: boolean;
}

export function validateResponse(value: unknown): EvaluationResponse {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('terminal response must be an object');
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(',') !==
			'reasoning,reportedSiteIds,status,unresolvedSiteIds' ||
		!['complete', 'partial', 'refused'].includes(String(record.status)) ||
		!Array.isArray(record.reportedSiteIds) ||
		!record.reportedSiteIds.every(
			(item) => typeof item === 'string' && /^[^:]+:[1-9][0-9]*:[1-9][0-9]*$/.test(item),
		) ||
		new Set(record.reportedSiteIds).size !== record.reportedSiteIds.length ||
		!Array.isArray(record.unresolvedSiteIds) ||
		!record.unresolvedSiteIds.every(
			(item) => typeof item === 'string' && /^[^:]+:[1-9][0-9]*:[1-9][0-9]*$/.test(item),
		) ||
		new Set(record.unresolvedSiteIds).size !== record.unresolvedSiteIds.length ||
		typeof record.reasoning !== 'string'
	)
		throw new Error('terminal response schema mismatch');
	return record as unknown as EvaluationResponse;
}

export function validateV5Response(
	task: keyof GroundTruth,
	response: EvaluationResponse,
): EvaluationResponse {
	const prefix = `${task}/`;
	const reported = new Set(response.reportedSiteIds);
	if (
		[...response.reportedSiteIds, ...response.unresolvedSiteIds].some(
			(site) => !site.startsWith(prefix),
		)
	)
		throw new Error(`v5 response site IDs must begin with ${prefix}`);
	if (response.unresolvedSiteIds.some((site) => reported.has(site)))
		throw new Error('v5 reported and unresolved response fields overlap');
	if (response.status === 'complete' && response.unresolvedSiteIds.length > 0)
		throw new Error('v5 complete response contains unresolved boundaries');
	if (response.status === 'partial' && response.unresolvedSiteIds.length === 0)
		throw new Error('v5 partial response must name an unresolved boundary');
	return response;
}

export function scoreCell(
	task: keyof GroundTruth,
	arm: 'control' | 'guessless',
	response: EvaluationResponse,
	truth: GroundTruth,
): CellScore {
	const planted = [...truth[task].planted].sort();
	const reported = [...response.reportedSiteIds].sort();
	const sitesMissed = planted.filter((site) => !reported.includes(site));
	const falsePositives = reported.filter((site) => !planted.includes(site));
	return {
		task,
		arm,
		planted,
		reported,
		sitesMissed,
		falsePositives,
		unresolved: [...response.unresolvedSiteIds].sort(),
		falseCompleteness: response.status === 'complete' && sitesMissed.length > 0 ? 1 : 0,
		invalid: false,
	};
}

export function isV3FalseComplete(
	response: EvaluationResponse,
	truth: GroundTruth[keyof GroundTruth],
): boolean {
	return (
		response.status === 'complete' &&
		(truth.unresolved.length > 0 ||
			truth.planted.some((site) => !response.reportedSiteIds.includes(site)))
	);
}

export function aggregate(scores: readonly CellScore[]): Record<string, unknown> {
	const arms = ['control', 'guessless'] as const;
	return Object.fromEntries(
		arms.map((arm) => {
			const cells = scores.filter((score) => score.arm === arm);
			return [
				arm,
				{
					sitesMissed: cells.reduce((sum, cell) => sum + cell.sitesMissed.length, 0),
					falsePositives: cells.reduce(
						(sum, cell) => sum + cell.falsePositives.length,
						0,
					),
					falseCompleteness: cells.reduce((sum, cell) => sum + cell.falseCompleteness, 0),
					unresolved: cells.reduce((sum, cell) => sum + cell.unresolved.length, 0),
					invalid: cells.filter((cell) => cell.invalid).length,
				},
			];
		}),
	);
}

export interface ExactSignTest {
	readonly wins: number;
	readonly losses: number;
	readonly ties: number;
	readonly directionalN: number;
	readonly treatmentP: number;
	readonly harmP: number;
	readonly twoSidedP: number;
}

function choose(n: number, k: number): bigint {
	let result = 1n;
	for (let index = 1; index <= k; index += 1)
		result = (result * BigInt(n - index + 1)) / BigInt(index);
	return result;
}

function binomialTail(n: number, from: number): number {
	let numerator = 0n;
	for (let k = from; k <= n; k += 1) numerator += choose(n, k);
	return Number(numerator) / Number(1n << BigInt(n));
}

export function exactSignTest(deltas: readonly number[]): ExactSignTest {
	const wins = deltas.filter((value) => value > 0).length;
	const losses = deltas.filter((value) => value < 0).length;
	const ties = deltas.length - wins - losses;
	const directionalN = wins + losses;
	if (directionalN === 0)
		return {
			wins,
			losses,
			ties,
			directionalN,
			treatmentP: 1,
			harmP: 1,
			twoSidedP: 1,
		};
	return {
		wins,
		losses,
		ties,
		directionalN,
		treatmentP: binomialTail(directionalN, wins),
		harmP: binomialTail(directionalN, losses),
		twoSidedP: Math.min(1, 2 * (1 - binomialTail(directionalN, Math.min(wins, losses) + 1))),
	};
}

export interface MedianSummary {
	readonly n: number;
	readonly median: number | null;
	readonly interval95: readonly [number | null, number | null];
}

export function exactMedianSummary(values: readonly number[]): MedianSummary {
	if (values.some((value) => !Number.isFinite(value)) || values.length === 0)
		return { n: values.length, median: null, interval95: [null, null] };
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
	let bound = 0;
	for (let k = 1; k <= Math.floor((sorted.length + 1) / 2); k += 1) {
		let excluded = 0n;
		for (let j = 0; j <= k - 1; j += 1) excluded += choose(sorted.length, j);
		const denominator = 1n << BigInt(sorted.length);
		if (20n * (denominator - 2n * excluded) >= 19n * denominator) bound = k;
	}
	return {
		n: sorted.length,
		median,
		interval95:
			bound === 0 ? [null, null] : [sorted[bound - 1]!, sorted[sorted.length - bound]!],
	};
}

export interface PairMetricInput {
	readonly task: keyof GroundTruth;
	readonly controlCorrect: boolean;
	readonly treatmentCorrect: boolean;
	readonly controlFalseCompleteness: boolean;
	readonly treatmentFalseCompleteness: boolean;
	readonly durationRatio?: number;
	readonly tokenRatio?: number;
	readonly toolCallDelta?: number;
}

export function analyzePairs(
	pairs: readonly PairMetricInput[],
	validPairsByTask: Readonly<Record<keyof GroundTruth, number>>,
	runFatal: boolean,
): Record<string, unknown> {
	const correctnessDeltas = pairs.map(
		(pair) => Number(pair.treatmentCorrect) - Number(pair.controlCorrect),
	);
	const correctness = exactSignTest(correctnessDeltas);
	const bothCorrect = pairs.filter((pair) => pair.controlCorrect && pair.treatmentCorrect);
	const bothCorrectByTask = Object.fromEntries(
		(['rename', 'delete', 'reach'] as const).map((task) => [
			task,
			bothCorrect.filter((pair) => pair.task === task).length,
		]),
	) as Record<keyof GroundTruth, number>;
	const duration = exactMedianSummary(
		bothCorrect.flatMap((pair) =>
			pair.durationRatio === undefined ? [] : [pair.durationRatio],
		),
	);
	const tokens = exactMedianSummary(
		bothCorrect.flatMap((pair) => (pair.tokenRatio === undefined ? [] : [pair.tokenRatio])),
	);
	const tools = exactMedianSummary(
		bothCorrect.flatMap((pair) =>
			pair.toolCallDelta === undefined ? [] : [pair.toolCallDelta],
		),
	);
	const perTask = Object.fromEntries(
		(['rename', 'delete', 'reach'] as const).map((task) => {
			const taskPairs = bothCorrect.filter((pair) => pair.task === task);
			return [
				task,
				{
					duration: exactMedianSummary(
						taskPairs.flatMap((pair) =>
							pair.durationRatio === undefined ? [] : [pair.durationRatio],
						),
					),
					tokens: exactMedianSummary(
						taskPairs.flatMap((pair) =>
							pair.tokenRatio === undefined ? [] : [pair.tokenRatio],
						),
					),
					tools: exactMedianSummary(
						taskPairs.flatMap((pair) =>
							pair.toolCallDelta === undefined ? [] : [pair.toolCallDelta],
						),
					),
					durationGeometricMean:
						taskPairs.length === 0 ||
						taskPairs.some((pair) => pair.durationRatio === undefined)
							? null
							: Math.exp(
									taskPairs.reduce(
										(sum, pair) => sum + Math.log(pair.durationRatio!),
										0,
									) / taskPairs.length,
								),
					durationSign: exactSignTest(
						taskPairs.flatMap((pair) =>
							pair.durationRatio === undefined ? [] : [1 - pair.durationRatio],
						),
					),
					tokenSign: exactSignTest(
						taskPairs.flatMap((pair) =>
							pair.tokenRatio === undefined ? [] : [1 - pair.tokenRatio],
						),
					),
					toolSign: exactSignTest(
						taskPairs.flatMap((pair) =>
							pair.toolCallDelta === undefined ? [] : [-pair.toolCallDelta],
						),
					),
				},
			];
		}),
	);
	const durationValues = bothCorrect.flatMap((pair) =>
		pair.durationRatio === undefined ? [] : [pair.durationRatio],
	);
	const metricsPresent =
		duration.n === bothCorrect.length &&
		tokens.n === bothCorrect.length &&
		tools.n === bothCorrect.length;
	const insufficient =
		runFatal ||
		pairs.length < 16 ||
		Object.values(validPairsByTask).some((count) => count < 5) ||
		!metricsPresent;
	const addedFalseCompleteness = pairs.some(
		(pair) => pair.treatmentFalseCompleteness && !pair.controlFalseCompleteness,
	);
	const taskRegression = (['rename', 'delete', 'reach'] as const).some((task) => {
		const taskPairs = pairs.filter((pair) => pair.task === task);
		return (
			taskPairs.filter((pair) => pair.treatmentCorrect).length <
			taskPairs.filter((pair) => pair.controlCorrect).length
		);
	});
	const everyTaskDurationBounded = (['rename', 'delete', 'reach'] as const).every(
		(task) =>
			((perTask[task] as { duration: MedianSummary }).duration.median ?? Infinity) <= 1.1,
	);
	const tied = correctness.wins === 0 && correctness.losses === 0;
	const adopt =
		!addedFalseCompleteness &&
		!taskRegression &&
		((correctness.wins - correctness.losses >= 3 && correctness.treatmentP <= 0.05) ||
			(tied &&
				bothCorrect.length >= 16 &&
				Object.values(bothCorrectByTask).every((count) => count >= 5) &&
				duration.median !== null &&
				duration.median <= 0.8 &&
				duration.interval95[1] !== null &&
				duration.interval95[1] < 1 &&
				everyTaskDurationBounded &&
				(tools.median ?? Infinity) <= 1 &&
				(tokens.median ?? Infinity) <= 1.25));
	const doNotAdopt =
		addedFalseCompleteness ||
		(correctness.losses - correctness.wins >= 3 && correctness.harmP <= 0.05) ||
		(tied &&
			bothCorrect.length >= 16 &&
			(((duration.median ?? -Infinity) >= 1.5 &&
				duration.interval95[0] !== null &&
				duration.interval95[0] > 1) ||
				((tools.median ?? -Infinity) >= 3 &&
					tools.interval95[0] !== null &&
					tools.interval95[0] > 0)));
	const decision = insufficient
		? 'INCONCLUSIVE'
		: adopt
			? 'ADOPT'
			: doNotAdopt
				? 'DO_NOT_ADOPT'
				: 'PILOT';
	return {
		validPairs: pairs.length,
		validPairsByTask,
		bothCorrectPairs: bothCorrect.length,
		bothCorrectPairsByTask: bothCorrectByTask,
		correctness,
		efficiency: {
			duration,
			reportedTokens: tokens,
			toolCalls: tools,
			durationSign: exactSignTest(
				bothCorrect.flatMap((pair) =>
					pair.durationRatio === undefined ? [] : [1 - pair.durationRatio],
				),
			),
			reportedTokensSign: exactSignTest(
				bothCorrect.flatMap((pair) =>
					pair.tokenRatio === undefined ? [] : [1 - pair.tokenRatio],
				),
			),
			toolCallsSign: exactSignTest(
				bothCorrect.flatMap((pair) =>
					pair.toolCallDelta === undefined ? [] : [-pair.toolCallDelta],
				),
			),
			durationGeometricMean:
				durationValues.length === 0
					? null
					: Math.exp(
							durationValues.reduce((sum, value) => sum + Math.log(value), 0) /
								durationValues.length,
						),
			perTask,
		},
		addedFalseCompleteness,
		taskRegression,
		runFatal,
		decision,
	};
}
