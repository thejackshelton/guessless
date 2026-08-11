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

export const V11_ID = 'oracle-part-3-v11';
export const V11_MODEL = V6_MODEL;
export const V11_CODEX_VERSION = V6_CODEX_VERSION;
export const V11_NODE_VERSION = V6_NODE_VERSION;
export const V11_PNPM_VERSION = V6_PNPM_VERSION;
export const V11_CODEX_EXECUTABLE_SHA256 = V6_CODEX_EXECUTABLE_SHA256;
export const V11_NODE_EXECUTABLE_SHA256 = V6_NODE_EXECUTABLE_SHA256;
export const V11_BUDGETS = {
	perCell: { ...V6_BUDGETS.perCell, maxReportedTokens: 500_000 },
	aggregate: {
		...V6_BUDGETS.aggregate,
		maxToolCalls: 16,
		maxReportedTokens: 500_000,
	},
} as const;
export const V11_POLICY = {
	...V6_POLICY,
	cellCount: 1,
	naturalSelectionMinimum: 1,
	naturalSelectionDenominator: 1,
} as const;
export const V11_REPOSITORIES = V6_REPOSITORIES;
export const V11_TASKS: readonly V6Task[] = [V6_TASKS[0]!];
export const V11_ROLES = V6_ROLES;
export const V11_UNRESOLVED_REASONS = V6_UNRESOLVED_REASONS;
export const V11_SCORING_GATES = V6_SCORING_GATES;
export const V11_NEUTRAL_SYSTEM_INSTRUCTION = V6_NEUTRAL_SYSTEM_INSTRUCTION;
export const V11_MAX_ANSWER_BYTES = 2_097_152;
export const V11_MAX_SEAL_BYTES = 512;

export type V11CellKind = 'consumption' | 'discovery';
export type V11CellArm = 'full' | 'paged' | 'control' | 'production';

export interface V11Cell {
	readonly id: string;
	readonly taskId: string;
	readonly kind: V11CellKind;
	readonly arm: V11CellArm;
	readonly ordinal: number;
}

export interface V11Response {
	readonly state: 'complete' | 'partial' | 'refused';
	readonly resolved: readonly { readonly siteId: string; readonly roles: readonly string[] }[];
	readonly unresolved: readonly { readonly siteId: string; readonly reason: string }[];
	readonly reasoning: string;
}

export interface V11AnswerSeal {
	readonly schema: 'guessless.v11-answer-seal/v1';
	readonly taskId: string;
	readonly path: 'answer.json';
	readonly bytes: number;
	readonly sha256: string;
}

export const V11_RESPONSE_SCHEMA = {
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

export const V11_SEAL_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	additionalProperties: false,
	required: ['schema', 'taskId', 'path', 'bytes', 'sha256'],
	properties: {
		schema: { type: 'string', const: 'guessless.v11-answer-seal/v1' },
		taskId: { type: 'string' },
		path: { type: 'string', const: 'answer.json' },
		bytes: { type: 'integer', minimum: 1, maximum: V11_MAX_ANSWER_BYTES },
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

export function v11PackageRoot(moduleUrl = import.meta.url): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export function v11RepositoryRoot(moduleUrl = import.meta.url): string {
	return resolve(v11PackageRoot(moduleUrl), '../..');
}

export function v11FixtureRoot(moduleUrl = import.meta.url): string {
	return join(v11PackageRoot(moduleUrl), 'fixtures', V11_ID);
}

export function v11EvidenceRoot(moduleUrl = import.meta.url): string {
	return join(v11RepositoryRoot(moduleUrl), 'docs', 'evidence', V11_ID);
}

export function buildV11Order(): V11Cell[] {
	const task = V11_TASKS[0]!;
	return [
		{
			id: `v11-01-${task.id}-production`,
			taskId: task.id,
			kind: 'discovery',
			arm: 'production',
			ordinal: 1,
		},
	];
}

export function v11TaskPrompt(task: V6Task): string {
	return `Assess the complete structural impact of the proposed ${task.intent} change to symbol '${task.symbol}' in '${task.file}'. Return every resolved canonical site with its ordered roles and every unresolved canonical site with its closed reason. Site IDs are deterministic source projections: use <path>:<one-based-line>:<one-based-UTF-8-byte-column>#resolved for resolved facts and <path>:<one-based-line>:<one-based-UTF-8-byte-column>#unresolved:<closed-reason> for unresolved facts. Use status complete only when no requested boundary remains unresolved; otherwise use partial or refused.`;
}

export function buildV11Prompts(): Record<string, unknown> {
	return Object.fromEntries(
		V11_TASKS.map((task) => [
			task.id,
			{
				discovery: v11TaskPrompt(task),
				consumption: {
					full: `${v11TaskPrompt(task)} A full integrity-bound structural artifact is supplied as read-only local input.`,
					paged: `${v11TaskPrompt(task)} A paged integrity-bound structural artifact is supplied as read-only local input; page and proof reads are separately counted.`,
				},
			},
		]),
	);
}
