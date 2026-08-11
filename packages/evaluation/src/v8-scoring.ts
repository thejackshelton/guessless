import type { V6DeliveryAccounting } from './v6-codex.ts';
import {
	decideV6,
	scoreV6Response,
	validateV6Response,
	type V6CellScore,
	type V6TruthShape,
} from './v6-scoring.ts';
import type { V8CellArm, V8CellKind } from './v8-contracts.ts';

export type V8CellScore = V6CellScore;
export type V8TruthShape = V6TruthShape;

export interface V8RecordedCell {
	readonly id: string;
	readonly taskId: string;
	readonly intent: 'rename' | 'delete' | 'entry-point';
	readonly kind: V8CellKind;
	readonly arm: V8CellArm;
	readonly score: V8CellScore;
	readonly delivery: V6DeliveryAccounting;
	readonly initialBytes: number;
	readonly semanticCalls: number;
	readonly warmSemanticCalls: number;
	readonly artifactBytes: number;
}

export const validateV8Response = validateV6Response;
export const scoreV8Response = scoreV6Response;

export function decideV8(cells: readonly V8RecordedCell[]) {
	return decideV6(
		cells.map((cell) => ({
			...cell,
			id: cell.id.replace(/^v8-/, 'v6-').replace(/-paged$/, '-summary'),
			arm: cell.arm === 'paged' ? ('summary' as const) : cell.arm,
		})),
	);
}
