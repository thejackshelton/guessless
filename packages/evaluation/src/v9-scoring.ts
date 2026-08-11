import type { V6DeliveryAccounting } from './v6-codex.ts';
import {
	decideV6,
	scoreV6Response,
	validateV6Response,
	type V6CellScore,
	type V6TruthShape,
} from './v6-scoring.ts';
import type { V9CellArm, V9CellKind } from './v9-contracts.ts';

export type V9CellScore = V6CellScore;
export type V9TruthShape = V6TruthShape;

export interface V9RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: 'rename' | 'delete' | 'entry-point';
	readonly kind: V9CellKind;
	readonly arm: V9CellArm;
	readonly score: V9CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
	readonly artifactBytes: number;
}

export const validateV9Response = validateV6Response;
export const scoreV9Response = scoreV6Response;

export function decideV9(cells: readonly V9RecordedCell[]) {
	return decideV6(
		cells.map((cell) => ({
			...cell,
			id: cell.id.replace(/^v9-/, 'v6-').replace(/-paged$/, '-summary'),
			arm: cell.arm === 'paged' ? ('summary' as const) : cell.arm,
		})),
	);
}
