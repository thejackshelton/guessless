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

export const V8_ID = 'oracle-part-3-v8';
export const V8_MODEL = V6_MODEL;
export const V8_CODEX_VERSION = V6_CODEX_VERSION;
export const V8_NODE_VERSION = V6_NODE_VERSION;
export const V8_PNPM_VERSION = V6_PNPM_VERSION;
export const V8_CODEX_EXECUTABLE_SHA256 = V6_CODEX_EXECUTABLE_SHA256;
export const V8_NODE_EXECUTABLE_SHA256 = V6_NODE_EXECUTABLE_SHA256;
export const V8_BUDGETS = V6_BUDGETS;
export const V8_POLICY = V6_POLICY;
export const V8_REPOSITORIES = V6_REPOSITORIES;
export const V8_TASKS = V6_TASKS;
export const V8_ROLES = V6_ROLES;
export const V8_UNRESOLVED_REASONS = V6_UNRESOLVED_REASONS;
export const V8_SCORING_GATES = V6_SCORING_GATES;
export const V8_NEUTRAL_SYSTEM_INSTRUCTION = V6_NEUTRAL_SYSTEM_INSTRUCTION;
export const V8_MAX_ANSWER_BYTES = 2_097_152;
export const V8_MAX_SEAL_BYTES = 512;

export type V8CellKind = 'consumption' | 'discovery';
export type V8CellArm = 'full' | 'paged' | 'control' | 'production';

export interface V8Cell {
	readonly id: string;
	readonly taskId: string;
	readonly kind: V8CellKind;
	readonly arm: V8CellArm;
	readonly ordinal: number;
}

export interface V8Response {
	readonly state: 'complete' | 'partial' | 'refused';
	readonly resolved: readonly { readonly siteId: string; readonly roles: readonly string[] }[];
	readonly unresolved: readonly { readonly siteId: string; readonly reason: string }[];
	readonly reasoning: string;
}

export interface V8AnswerSeal {
	readonly schema: 'guessless.v8-answer-seal/v1';
	readonly taskId: string;
	readonly path: 'answer.json';
	readonly bytes: number;
	readonly sha256: string;
}

export const V8_RESPONSE_SCHEMA = {
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

export const V8_SEAL_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	additionalProperties: false,
	required: ['schema', 'taskId', 'path', 'bytes', 'sha256'],
	properties: {
		schema: { const: 'guessless.v8-answer-seal/v1' },
		taskId: { type: 'string' },
		path: { const: 'answer.json' },
		bytes: { type: 'integer', minimum: 1, maximum: V8_MAX_ANSWER_BYTES },
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

export function v8PackageRoot(moduleUrl = import.meta.url): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function v8RepositoryRoot(moduleUrl = import.meta.url): string {
	return resolve(v8PackageRoot(moduleUrl), '../..');
}

export function v8FixtureRoot(moduleUrl = import.meta.url): string {
	return join(v8PackageRoot(moduleUrl), 'fixtures', V8_ID);
}

export function v8EvidenceRoot(moduleUrl = import.meta.url): string {
	return join(v8RepositoryRoot(moduleUrl), 'docs', 'evidence', V8_ID);
}

export function buildV8Order(): V8Cell[] {
	const order: V8Cell[] = [];
	for (const [index, task] of V8_TASKS.entries()) {
		const consumption =
			index % 2 === 0 ? (['full', 'paged'] as const) : (['paged', 'full'] as const);
		const discovery =
			index % 2 === 0
				? (['control', 'production'] as const)
				: (['production', 'control'] as const);
		for (const arm of consumption)
			order.push({
				id: `v8-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'consumption',
				arm,
				ordinal: order.length + 1,
			});
		for (const arm of discovery)
			order.push({
				id: `v8-${String(order.length + 1).padStart(2, '0')}-${task.id}-${arm}`,
				taskId: task.id,
				kind: 'discovery',
				arm,
				ordinal: order.length + 1,
			});
	}
	return order;
}

export function v8TaskPrompt(task: V6Task): string {
	return `Assess the complete structural impact of the proposed ${task.intent} change to symbol '${task.symbol}' in '${task.file}'. Return every resolved canonical site with its ordered roles and every unresolved canonical site with its closed reason. Site IDs are deterministic source projections: use <path>:<one-based-line>:<one-based-UTF-8-byte-column>#resolved for resolved facts and <path>:<one-based-line>:<one-based-UTF-8-byte-column>#unresolved:<closed-reason> for unresolved facts. Use status complete only when no requested boundary remains unresolved; otherwise use partial or refused.`;
}

export function buildV8Prompts(): Record<string, unknown> {
	return Object.fromEntries(
		V8_TASKS.map((task) => [
			task.id,
			{
				discovery: v8TaskPrompt(task),
				consumption: {
					full: `${v8TaskPrompt(task)} A full integrity-bound structural artifact is supplied as read-only local input.`,
					paged: `${v8TaskPrompt(task)} A paged integrity-bound structural artifact is supplied as read-only local input; page and proof reads are separately counted.`,
				},
			},
		]),
	);
}
