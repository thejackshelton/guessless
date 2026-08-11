import type { V6DeliveryAccounting } from './v6-codex.ts';
import {
	decideV6,
	scoreV6Response,
	validateV6Response,
	type V6CellScore,
	type V6TruthShape,
} from './v6-scoring.ts';
import type { V7CellArm, V7CellKind } from './v7-contracts.ts';

export type V7CellScore = V6CellScore;
export type V7TruthShape = V6TruthShape;

export interface V7RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: 'rename' | 'delete' | 'entry-point';
	readonly kind: V7CellKind;
	readonly arm: V7CellArm;
	readonly score: V7CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
	readonly artifactBytes: number;
}

export const validateV7Response = validateV6Response;
export const scoreV7Response = scoreV6Response;

export function decideV7(cells: readonly V7RecordedCell[]) {
	return decideV6(
		cells.map((cell) => ({
			...cell,
			id: cell.id.replace(/^v7-/, 'v6-').replace(/-paged$/, '-summary'),
			arm: cell.arm === 'paged' ? ('summary' as const) : cell.arm,
		})),
	);
}
