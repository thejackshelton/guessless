import type { V6DeliveryAccounting } from './v6-codex.ts';
import {
	decideV6,
	scoreV6Response,
	validateV6Response,
	type V6CellScore,
	type V6TruthShape,
} from './v6-scoring.ts';
import type { V11CellArm, V11CellKind } from './v11-contracts.ts';

export type V11CellScore = V6CellScore;
export type V11TruthShape = V6TruthShape;

export interface V11RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: 'rename' | 'delete' | 'entry-point';
	readonly kind: V11CellKind;
	readonly arm: V11CellArm;
	readonly score: V11CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
	readonly artifactBytes: number;
}

export const validateV11Response = validateV6Response;
export const scoreV11Response = scoreV6Response;

export function decideV11(cells: readonly V11RecordedCell[]) {
	return decideV6(
		cells.map((cell) => ({
			...cell,
			id: cell.id.replace(/^v11-/, 'v6-').replace(/-paged$/, '-summary'),
			arm: cell.arm === 'paged' ? ('summary' as const) : cell.arm,
		})),
	);
}
