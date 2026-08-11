import type { V6DeliveryAccounting } from './v6-codex.ts';
import {
	decideV6,
	scoreV6Response,
	validateV6Response,
	type V6CellScore,
	type V6TruthShape,
} from './v6-scoring.ts';
import type { V10CellArm, V10CellKind } from './v10-contracts.ts';

export type V10CellScore = V6CellScore;
export type V10TruthShape = V6TruthShape;

export interface V10RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: 'rename' | 'delete' | 'entry-point';
	readonly kind: V10CellKind;
	readonly arm: V10CellArm;
	readonly score: V10CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
	readonly artifactBytes: number;
}

export const validateV10Response = validateV6Response;
export const scoreV10Response = scoreV6Response;

export function decideV10(cells: readonly V10RecordedCell[]) {
	return decideV6(
		cells.map((cell) => ({
			...cell,
			id: cell.id.replace(/^v10-/, 'v6-').replace(/-paged$/, '-summary'),
			arm: cell.arm === 'paged' ? ('summary' as const) : cell.arm,
		})),
	);
}
