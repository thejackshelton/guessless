import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	V6_BUDGETS,
	V6_CODEX_EXECUTABLE_SHA256,
	V6_CODEX_VERSION,
	V6_MODEL,
	V6_NEUTRAL_SYSTEM_INSTRUCTION,
	V6_NODE_EXECUTABLE_SHA256,
	V6_NODE_VERSION,
	V6_PNPM_VERSION,
	V6_POLICY,
	V6_REPOSITORIES,
	V6_ROLES,
	V6_SCORING_GATES,
	V6_TASKS,
	V6_UNRESOLVED_REASONS,
	type V6Task,
} from './v6-contracts.ts';

export const V7_ID = 'oracle-part-3-v7';
export const V7_MODEL = V6_MODEL;
export const V7_CODEX_VERSION = V6_CODEX_VERSION;
export const V7_NODE_VERSION = V6_NODE_VERSION;
export const V7_PNPM_VERSION = V6_PNPM_VERSION;
export const V7_CODEX_EXECUTABLE_SHA256 = V6_CODEX_EXECUTABLE_SHA256;
export const V7_NODE_EXECUTABLE_SHA256 = V6_NODE_EXECUTABLE_SHA256;
export const V7_BUDGETS = V6_BUDGETS;
export const V7_POLICY = V6_POLICY;
export const V7_REPOSITORIES = V6_REPOSITORIES;
export const V7_TASKS = V6_TASKS;
export const V7_ROLES = V6_ROLES;
export const V7_UNRESOLVED_REASONS = V6_UNRESOLVED_REASONS;
export const V7_SCORING_GATES = V6_SCORING_GATES;
export const V7_NEUTRAL_SYSTEM_INSTRUCTION = V6_NEUTRAL_SYSTEM_INSTRUCTION;
export const V7_MAX_ANSWER_BYTES = 2_097_152;
export const V7_MAX_SEAL_BYTES = 512;

export type V7CellKind = 'consumption' | 'discovery';
export type V7CellArm = 'full' | 'paged' | 'control' | 'production';

export interface V7Cell {
	readonly id: string;
	readonly taskId: string;
	readonly kind: V7CellKind;
	readonly arm: V7CellArm;
	readonly ordinal: number;
}

export interface V7Response {
	readonly state: 'complete' | 'partial' | 'refused';
	readonly resolved: readonly { readonly siteId: string; readonly roles: readonly string[] }[];
	readonly unresolved: readonly { readonly siteId: string; readonly reason: string }[];
	readonly reasoning: string;
}

export interface V7AnswerSeal {
	readonly schema: 'guessless.v7-answer-seal/v1';
	readonly taskId: string;
	readonly path: 'answer.json';
	readonly bytes: number;
	readonly sha256: string;
}

export const V7_RESPONSE_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	additionalProperties: false,
	required: ['state', 'resolved', 'unresolved', 'reasoning'],
	properties: {
		state: { enum: ['complete', 'partial', 'refused'] },
		resolved: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['siteId', 'roles'],
				properties: {
					siteId: { type: 'string' },
					roles: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		unresolved: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['siteId', 'reason'],
				properties: {
					siteId: { type: 'string' },
					reason: { type: 'string' },
				},
			},
		},
		reasoning: { type: 'string' },
	},
} as const;

export const V7_SEAL_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	additionalProperties: false,
	required: ['schema', 'taskId', 'path', 'bytes', 'sha256'],
	properties: {
		schema: { const: 'guessless.v7-answer-seal/v1' },
		taskId: { type: 'string' },
		path: { const: 'answer.json' },
		bytes: { type: 'integer', minimum: 1, maximum: V7_MAX_ANSWER_BYTES },
		sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
	},
} as const;

export function sha256(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex');
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sorted(nested)]),
	);
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

export function v7PackageRoot(moduleUrl = import.meta.url): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function v7RepositoryRoot(moduleUrl = import.meta.url): string {
	return resolve(v7PackageRoot(moduleUrl), '../..');
}

export function v7FixtureRoot(moduleUrl = import.meta.url): string {
	return join(v7PackageRoot(moduleUrl), 'fixtures', V7_ID);
}

export function v7EvidenceRoot(moduleUrl = import.meta.url): string {
	return join(v7RepositoryRoot(moduleUrl), 'docs', 'evidence', V7_ID);
}

export function buildV7Order(): V7Cell[] {
	const order: V7Cell[] = [];
	for (const [index, task] of V7_TASKS.entries()) {
		const consumption =
			index % 2 === 0 ? (['full', 'paged'] as const) : (['paged', 'full'] as const);
		const discovery =
			index % 2 === 0
				? (['control', 'production'] as const)
				: (['production', 'control'] as const);
		for (const arm of consumption)
			order.push({
				id: `v7-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'consumption',
				arm,
				ordinal: order.length + 1,
			});
		for (const arm of discovery)
			order.push({
				id: `v7-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'discovery',
				arm,
				ordinal: order.length + 1,
			});
	}
	return order;
}

export function v7TaskPrompt(task: V6Task): string {
	return `Assess the complete structural impact of the proposed ${task.intent} change to symbol '${task.symbol}' in '${task.file}'. Return every resolved canonical site with its ordered roles and every unresolved canonical site with its closed reason. Site IDs are deterministic source projections: use <path>:<one-based-line>:<one-based-UTF-8-byte-column>#resolved for resolved facts and <path>:<one-based-line>:<one-based-UTF-8-byte-column>#unresolved:<closed-reason> for unresolved facts. Use status complete only when no requested boundary remains unresolved; otherwise use partial or refused.`;
}

export function buildV7Prompts(): Record<string, unknown> {
	return Object.fromEntries(
		V7_TASKS.map((task) => [
			task.id,
			{
				discovery: v7TaskPrompt(task),
				consumption: {
					full: `${v7TaskPrompt(task)} A full integrity-bound structural artifact is supplied as read-only local input.`,
					paged: `${v7TaskPrompt(task)} A paged integrity-bound structural artifact is supplied as read-only local input; page and proof reads are separately counted.`,
				},
			},
		]),
	);
}
