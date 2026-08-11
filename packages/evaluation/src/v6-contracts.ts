import { createHash } from 'node:crypto';

export const V6_ID = 'oracle-part-3-v6';
export const V6_MODEL = 'gpt-5.6-sol';
export const V6_CODEX_VERSION = '0.147.0';
export const V6_NODE_VERSION = '24.15.0';
export const V6_PNPM_VERSION = '10.33.2';
export const V6_CODEX_EXECUTABLE_SHA256 =
	'134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477';
export const V6_NODE_EXECUTABLE_SHA256 =
	'3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32';

export const V6_BUDGETS = {
	perCell: { maxToolCalls: 16, maxReportedTokens: 160_000, timeoutMs: 300_000 },
	aggregate: {
		maxToolCalls: 1_152,
		maxReportedTokens: 11_520_000,
		maxDurationMs: 21_600_000,
		maxAcquiredBytes: 250 * 1024 * 1024,
		maxIncrementalDirectSpendUsd: 0,
	},
} as const;

export const V6_POLICY = {
	cellCount: 72,
	calibrationCalls: 0,
	retries: 0,
	replacements: 0,
	rescoring: false,
	sameIdReruns: false,
	completionMinimum: 0.99,
	naturalSelectionMinimum: 15,
	naturalSelectionDenominator: 18,
} as const;

export const V6_ROLES = [
	'declaration',
	'reference',
	'read',
	'write',
	'read-write',
	'call',
	'import',
	'export',
	'alias',
	'namespace',
	'barrel',
	'witness',
] as const;

export const V6_UNRESOLVED_REASONS = [
	'unparsed-file',
	'unsupported-language',
	'unsupported-syntax',
	'unresolved-specifier',
	'external-module-boundary',
	'builtin-module-boundary',
	'linked-set-boundary',
	'unresolved-symbol',
	'ambiguous-definition',
	'dynamic-member-access',
	'computed-property-key',
	'string-keyed-lookup',
	'property-alias-write-uncertain',
	'higher-order-call-boundary',
	'stale-snapshot',
] as const;

export type V6Intent = 'rename' | 'delete' | 'entry-point';
export type V6RepositoryId = 'ufo' | 'execa' | 'uvu';

export interface V6Repository {
	readonly id: V6RepositoryId;
	readonly owner: string;
	readonly repository: string;
	readonly commit: string;
	readonly archive: string;
	readonly archiveSha256: string;
	readonly archiveBytes: number;
	readonly rootDirectory: string;
	readonly sourceDirectory: string;
	readonly licensePath: string;
	readonly licenseSha256: string;
}

export const V6_REPOSITORIES: readonly V6Repository[] = [
	{
		id: 'ufo',
		owner: 'unjs',
		repository: 'ufo',
		commit: 'f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6',
		archive: 'ufo.tar.gz',
		archiveSha256: '9a929027362efdf9065ff90b1ef08b7ecd635c8ef0b1614de8deacd435d9944e',
		archiveBytes: 156_073,
		rootDirectory: 'ufo-f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6',
		sourceDirectory: 'src',
		licensePath: 'LICENSE',
		licenseSha256: '46231df5a7733c3f52f11b71f3df61813007745b62b09031acfb45fb42d75082',
	},
	{
		id: 'execa',
		owner: 'sindresorhus',
		repository: 'execa',
		commit: '8017b279e19347efaf2587711c2d57dbd4330740',
		archive: 'execa.tar.gz',
		archiveSha256: 'dc079e14ef2aa694efac6c350e400ac6ded3716e4ced14ed99424e95d986e9e6',
		archiveBytes: 347_360,
		rootDirectory: 'execa-8017b279e19347efaf2587711c2d57dbd4330740',
		sourceDirectory: 'lib',
		licensePath: 'license',
		licenseSha256: '5c932d88256b4ab958f64a856fa48e8bd1f55bc1d96b8149c65689e0c61789d3',
	},
	{
		id: 'uvu',
		owner: 'lukeed',
		repository: 'uvu',
		commit: '9419247b8f93b61ce9a3aeca562f08491101a765',
		archive: 'uvu.tar.gz',
		archiveSha256: 'b698493e9a43172994c58ebd3bd2f2f4c35766eb8bcffe8b8d725f0bd01ba610',
		archiveBytes: 134_438,
		rootDirectory: 'uvu-9419247b8f93b61ce9a3aeca562f08491101a765',
		sourceDirectory: 'src',
		licensePath: 'license',
		licenseSha256: '306fa513e39b23a6e8747520de761809d206b99800ef41907b530226574c59ae',
	},
] as const;

export interface V6Task {
	readonly id: string;
	readonly repository: V6RepositoryId;
	readonly intent: V6Intent;
	readonly file: string;
	readonly symbol: string;
}

export const V6_TASKS: readonly V6Task[] = [
	{
		id: 'ufo-rename-encode-query-item',
		repository: 'ufo',
		intent: 'rename',
		file: 'src/query.ts',
		symbol: 'encodeQueryItem',
	},
	{
		id: 'ufo-rename-with-trailing-slash',
		repository: 'ufo',
		intent: 'rename',
		file: 'src/utils.ts',
		symbol: 'withTrailingSlash',
	},
	{
		id: 'ufo-delete-create-url',
		repository: 'ufo',
		intent: 'delete',
		file: 'src/url.ts',
		symbol: 'createURL',
	},
	{
		id: 'ufo-delete-parse-url',
		repository: 'ufo',
		intent: 'delete',
		file: 'src/parse.ts',
		symbol: 'parseURL',
	},
	{
		id: 'ufo-entry-stringify-query',
		repository: 'ufo',
		intent: 'entry-point',
		file: 'src/query.ts',
		symbol: 'stringifyQuery',
	},
	{
		id: 'ufo-entry-normalize-url',
		repository: 'ufo',
		intent: 'entry-point',
		file: 'src/utils.ts',
		symbol: 'normalizeURL',
	},
	{
		id: 'execa-rename-normalize-options',
		repository: 'execa',
		intent: 'rename',
		file: 'lib/arguments/options.js',
		symbol: 'normalizeOptions',
	},
	{
		id: 'execa-rename-wait-subprocess-result',
		repository: 'execa',
		intent: 'rename',
		file: 'lib/resolve/wait-subprocess.js',
		symbol: 'waitForSubprocessResult',
	},
	{
		id: 'execa-delete-parse-command-string',
		repository: 'execa',
		intent: 'delete',
		file: 'lib/methods/command.js',
		symbol: 'parseCommandString',
	},
	{
		id: 'execa-delete-normalize-cwd',
		repository: 'execa',
		intent: 'delete',
		file: 'lib/arguments/cwd.js',
		symbol: 'normalizeCwd',
	},
	{
		id: 'execa-entry-execa-core-async',
		repository: 'execa',
		intent: 'entry-point',
		file: 'lib/methods/main-async.js',
		symbol: 'execaCoreAsync',
	},
	{
		id: 'execa-entry-create-execa',
		repository: 'execa',
		intent: 'entry-point',
		file: 'lib/methods/create.js',
		symbol: 'createExeca',
	},
	{
		id: 'uvu-rename-runner',
		repository: 'uvu',
		intent: 'rename',
		file: 'src/index.js',
		symbol: 'runner',
	},
	{
		id: 'uvu-rename-stringify',
		repository: 'uvu',
		intent: 'rename',
		file: 'src/diff.js',
		symbol: 'stringify',
	},
	{
		id: 'uvu-delete-fixture',
		repository: 'uvu',
		intent: 'delete',
		file: 'src/assert.js',
		symbol: 'fixture',
	},
	{
		id: 'uvu-delete-direct',
		repository: 'uvu',
		intent: 'delete',
		file: 'src/diff.js',
		symbol: 'direct',
	},
	{
		id: 'uvu-entry-exec',
		repository: 'uvu',
		intent: 'entry-point',
		file: 'src/index.js',
		symbol: 'exec',
	},
	{
		id: 'uvu-entry-equal',
		repository: 'uvu',
		intent: 'entry-point',
		file: 'src/assert.js',
		symbol: 'equal',
	},
] as const;

export const V6_NEUTRAL_SYSTEM_INSTRUCTION =
	'Work only in the supplied read-only repository snapshot. Do not use network access, install packages, modify files, or read user configuration. Return exactly the requested JSON schema. Classify every requested site as resolved or unresolved; never claim complete while a requested site remains unclassified. Use available tools only when they help, and report only delivered results.';

export const V6_SCORING_GATES = {
	completion: 'all 72 cells; 71/72 is below 99%',
	naturalSelection:
		'at least 15 of 18 production cells deliver applicable prepare and impact results',
	coldWarmCalls: 'at most two cold semantic calls and one warm semantic call',
	falseCompleteness: 'zero added treatment false completeness',
	taskRegression: 'no task-kind correctness regression',
	correctness: 'at least four net paired wins with one-sided exact p <= 0.10',
	efficiency: 'at least 20% lower end-to-end time or 25% fewer total tool calls',
	progressiveBytes: 'initial complete CallToolResult bytes at least 50% lower',
	progressiveTokens: 'reported downstream tokens at least 25% lower',
	progressiveQuality:
		'identical correctness, zero coordinate-role errors, no hidden unresolved site',
	progressiveCalls: 'no extra median follow-up call; proof access counted separately',
	decision: 'GO only when every gate passes; otherwise NO_GO',
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
