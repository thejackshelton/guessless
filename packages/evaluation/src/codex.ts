import { spawnSync } from 'node:child_process';
import {
	accessSync,
	constants,
	cpSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
	assertCanonicalExisting,
	CODEX_VERSION,
	V4_EVIDENCE_ID,
	V5_EVIDENCE_ID,
	sha256,
} from './contracts.ts';
import type { Protocol } from './fixtures.ts';
import { validateResponse, validateV5Response, type EvaluationResponse } from './scoring.ts';

export interface CodexRun {
	readonly argv: readonly string[];
	readonly environmentNames: readonly string[];
	readonly environmentValueFingerprints: Readonly<Record<string, string>>;
	readonly status: number;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly stdoutSha256: string;
	readonly stderrSha256: string;
	readonly toolCalls: number;
	readonly reportedTotalTokens: number;
	readonly guesslessInvocations: number;
	readonly spawnProvenance?: SpawnProvenance;
	readonly terminal?: EvaluationResponse;
	readonly failureReason?: string;
}

export interface SpawnProvenance {
	readonly attempted: boolean;
	readonly returned: boolean;
	readonly thrownMessage: string | null;
	readonly resultErrorMessage: string | null;
}

export type CellSpawner = typeof spawnSync;
export interface CodexCellConfig {
	readonly executable: string;
	readonly protocol: Protocol;
	readonly responseSchemaPath: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly mcpCommand: string;
	readonly mcpServer: string;
	readonly scratchParent?: string;
}

export class FatalEvaluationError extends Error {}

export function guesslessMcpArguments(config: CodexCellConfig): readonly string[] {
	return [
		'-c',
		`mcp_servers.guessless.command=${tomlString(config.mcpCommand)}`,
		'-c',
		`mcp_servers.guessless.args=[${tomlString(config.mcpServer)}]`,
	];
}

export function buildChildEnvironment(
	home: string = String(process.env.HOME),
	temporary: string = process.env.TMPDIR ?? tmpdir(),
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: assertCanonicalExisting(realpathSync(home), 'child HOME', 'directory'),
		LANG: 'C.UTF-8',
		PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
		TMPDIR: assertCanonicalExisting(realpathSync(temporary), 'child TMPDIR', 'directory'),
	};
	for (const [name, value] of Object.entries(environment)) {
		if (/(secret|token|key|password|credential|auth|cookie)/i.test(name))
			throw new Error('secret-like child environment name rejected');
		if (value === undefined || value.includes('\0'))
			throw new Error('invalid child environment value');
	}
	return environment;
}

export function resolveCodexExecutable(
	pathValue: string = String(process.env.PATH),
	versionReader: (absolute: string) => string,
): string {
	const candidates = pathValue
		.split(delimiter)
		.filter(Boolean)
		.map((directory) => join(directory, 'codex'));
	for (const candidate of candidates) {
		try {
			const absolute = resolve(candidate);
			if (!isAbsolute(absolute) || realpathSync(absolute) !== absolute) continue;
			const stat = lstatSync(absolute);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			accessSync(absolute, constants.X_OK);
			if (versionReader(absolute).trim() !== `codex-cli ${CODEX_VERSION}`)
				throw new Error('Codex version mismatch');
			return absolute;
		} catch (error) {
			if (error instanceof Error && error.message === 'Codex version mismatch') throw error;
		}
	}
	throw new Error('canonical executable Codex 0.146.0 not found');
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

export interface TranscriptInspection {
	toolCalls: number;
	reportedTotalTokens: number;
	guesslessInvocations: number;
	terminalMessages: number;
	terminal?: EvaluationResponse;
	error?: string;
}

export type TranscriptPolicy = 'legacy' | 'v4';

export function inspectCodexTranscript(
	stdoutBytes: Uint8Array,
	policy: TranscriptPolicy = 'legacy',
): TranscriptInspection {
	let toolCalls = 0;
	let reportedTotalTokens = 0;
	let guesslessInvocations = 0;
	let terminalText: string | undefined;
	let terminalMessages = 0;
	let eventIndex = 0;
	let lastTerminalEvent = -1;
	const turnCompletedEvents: number[] = [];
	let error: string | undefined;
	const bytes = Buffer.from(stdoutBytes);
	let offset = 0;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(0x0a, offset);
		if (newline < 0) {
			error = 'Codex stdout lacks terminal LF';
			break;
		}
		let event: Record<string, unknown>;
		try {
			const line = new TextDecoder('utf-8', { fatal: true }).decode(
				bytes.subarray(offset, newline),
			);
			event = JSON.parse(line) as Record<string, unknown>;
		} catch (cause) {
			error = `Codex JSONL parse failed: ${cause instanceof Error ? cause.message : String(cause)}`;
			break;
		}
		offset = newline + 1;
		eventIndex += 1;
		const item = event.item as Record<string, unknown> | undefined;
		if (
			event.type === 'item.started' &&
			item !== undefined &&
			['command_execution', 'mcp_tool_call', 'web_search'].includes(String(item.type))
		)
			toolCalls += 1;
		if (event.type === 'item.started' && item?.type === 'mcp_tool_call') {
			const server = String(item.server ?? item.server_name ?? '');
			if (server === 'guessless') guesslessInvocations += 1;
		}
		if (event.type === 'item.started' && item?.type === 'command_execution') {
			const command = item.command;
			if (
				(Array.isArray(command) &&
					command.some((part) => String(part).includes('packages/mcp/dist/server.js'))) ||
				(typeof command === 'string' &&
					/(?:^|\s)packages\/mcp\/dist\/server\.js(?:\s|$)/.test(command))
			)
				guesslessInvocations += 1;
		}
		if (event.type === 'item.completed' && item?.type === 'agent_message') {
			terminalMessages += 1;
			terminalText = String(item.text ?? '');
			lastTerminalEvent = eventIndex;
			if (policy === 'v4')
				try {
					validateResponse(JSON.parse(terminalText));
				} catch (cause) {
					error ??= `Codex terminal response failed: ${cause instanceof Error ? cause.message : String(cause)}`;
				}
		}
		if (event.type === 'turn.completed') {
			turnCompletedEvents.push(eventIndex);
			const usage = event.usage as Record<string, unknown> | undefined;
			const input = Number(usage?.input_tokens ?? 0);
			const output = Number(usage?.output_tokens ?? 0);
			if (
				![input, output].every(
					(value) => Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0,
				)
			) {
				error = 'Codex token counts must be finite nonnegative safe integers';
				break;
			}
			const total = input + output;
			if (!Number.isSafeInteger(total)) {
				error = 'Codex token sum exceeds safe integer range';
				break;
			}
			reportedTotalTokens = total;
		}
	}
	if (
		policy === 'v4' &&
		(terminalMessages < 1 ||
			turnCompletedEvents.length !== 1 ||
			turnCompletedEvents[0]! <= lastTerminalEvent)
	)
		error ??= 'Codex v4 terminal/turn ordering mismatch';
	let terminal: EvaluationResponse | undefined;
	if (terminalText !== undefined)
		try {
			terminal = validateResponse(JSON.parse(terminalText));
		} catch (cause) {
			error ??= `Codex terminal response failed: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	else error ??= 'Codex terminal agent message missing';
	return {
		toolCalls,
		reportedTotalTokens,
		guesslessInvocations,
		terminalMessages,
		...(terminal === undefined ? {} : { terminal }),
		...(error === undefined ? {} : { error }),
	};
}

export function replayCodexTranscript(
	stdoutBytes: Uint8Array,
	policy: TranscriptPolicy = 'legacy',
): TranscriptInspection & {
	terminal: EvaluationResponse;
} {
	const inspected = inspectCodexTranscript(stdoutBytes, policy);
	if (inspected.error !== undefined) throw new Error(inspected.error);
	if (inspected.terminal === undefined) throw new Error('Codex terminal agent message missing');
	return { ...inspected, terminal: inspected.terminal };
}

export function containsSecret(stdout: Uint8Array, stderr: Uint8Array): boolean {
	const captured = `${Buffer.from(stdout).toString('latin1')}\n${Buffer.from(stderr).toString('latin1')}`;
	return [
		/\bsk-[A-Za-z0-9_-]{16,}\b/,
		/\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
		/OPENAI_API_KEY\s*=/i,
		/authorization:\s*[^\s]+/i,
	].some((pattern) => pattern.test(captured));
}

export function runCodexCell(
	task: keyof Protocol['tasks'],
	arm: 'control' | 'guessless',
	inputRoot: string,
	config: CodexCellConfig,
	spawner: CellSpawner = spawnSync,
): CodexRun {
	const scratch = mkdtempSync(join(config.scratchParent ?? tmpdir(), 'structural-eval-cell-'));
	try {
		const taskRoot =
			config.protocol.evidenceId === V5_EVIDENCE_ID ? join(scratch, task) : scratch;
		cpSync(join(inputRoot, task), taskRoot, { recursive: true, errorOnExist: false });
		const argv = [
			'exec',
			'--ephemeral',
			'--ignore-user-config',
			'--ignore-rules',
			'--skip-git-repo-check',
			'--sandbox',
			'read-only',
			'--model',
			config.protocol.model,
			'--output-schema',
			config.responseSchemaPath,
			'--json',
			'-C',
			scratch,
			'-c',
			`developer_instructions=${tomlString(config.protocol.systemInstruction)}`,
		];
		if (arm === 'guessless') argv.push(...guesslessMcpArguments(config));
		argv.push(config.protocol.tasks[task]);
		const environment = { ...config.environment };
		const environmentSnapshot = JSON.stringify(environment, Object.keys(environment).sort());
		const started = Date.now();
		let result: ReturnType<CellSpawner> | undefined;
		let thrown: unknown;
		try {
			result = spawner(config.executable, argv, {
				cwd: scratch,
				env: environment,
				encoding: 'buffer',
				timeout: config.protocol.budgets.timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch (error) {
			thrown = error;
		}
		const mutatedEnvironment =
			JSON.stringify(environment, Object.keys(environment).sort()) !== environmentSnapshot;
		if (
			mutatedEnvironment &&
			Object.keys(environment).some((name) =>
				/(secret|token|key|password|credential|auth|cookie)/i.test(name),
			)
		)
			throw new FatalEvaluationError('spawner introduced a secret-like environment name');
		if (mutatedEnvironment && thrown === undefined)
			thrown = new Error('spawner mutated the frozen child environment');
		const environmentValueFingerprints = Object.fromEntries(
			Object.entries(environment).map(([name, value]) => [name, sha256(String(value))]),
		);
		const durationMs = Date.now() - started;
		const stdout = result?.stdout instanceof Uint8Array ? result.stdout : Buffer.alloc(0);
		const stderr = result?.stderr instanceof Uint8Array ? result.stderr : Buffer.alloc(0);
		if (containsSecret(stdout, stderr))
			throw new FatalEvaluationError('captured Codex stream contains a secret pattern');
		const status = result?.status ?? -1;
		const signal = result?.signal ?? null;
		const timedOut = result?.error?.message.includes('ETIMEDOUT') ?? false;
		const parsed = inspectCodexTranscript(
			stdout,
			[V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(config.protocol.evidenceId) ? 'v4' : 'legacy',
		);
		const spawnProvenance: SpawnProvenance = {
			attempted: true,
			returned: result !== undefined,
			thrownMessage:
				thrown === undefined
					? null
					: thrown instanceof Error
						? thrown.message
						: String(thrown),
			resultErrorMessage: result?.error?.message ?? null,
		};
		const failureReasons: string[] = [];
		if (spawnProvenance.thrownMessage !== null)
			failureReasons.push(`TRANSPORT: ${spawnProvenance.thrownMessage}`);
		if (result === undefined) failureReasons.push('NO_RESULT: spawn returned no result');
		if (status !== 0) failureReasons.push(`PROCESS_STATUS: ${status}`);
		if (signal !== null) failureReasons.push(`SIGNAL: ${signal}`);
		if (timedOut) failureReasons.push('TIMEOUT: true');
		if (result?.error !== undefined)
			failureReasons.push(`TRANSPORT_ERROR: ${result.error.message}`);
		if (parsed?.error !== undefined) failureReasons.push(`TRANSCRIPT: ${parsed.error}`);
		if (config.protocol.evidenceId === V5_EVIDENCE_ID && parsed.terminal !== undefined)
			try {
				validateV5Response(task, parsed.terminal);
			} catch (error) {
				failureReasons.push(
					`RESPONSE_CONTRACT: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		if (config.protocol.evidenceId === 'oracle-part-3-v3' && parsed.terminalMessages !== 1)
			failureReasons.push(
				`TRANSCRIPT: Codex terminal agent message count mismatch: ${parsed.terminalMessages}`,
			);
		if (parsed.error === 'Codex token sum exceeds safe integer range')
			failureReasons.push('UNSAFE_TOKEN_SUM: true');
		if ((parsed?.toolCalls ?? 0) > config.protocol.budgets.maxToolCalls)
			failureReasons.push(
				`TOOL_BUDGET_EXCEEDED: ${parsed!.toolCalls}>${config.protocol.budgets.maxToolCalls}`,
			);
		if (
			'maxReportedTotalTokens' in config.protocol.budgets &&
			(parsed?.reportedTotalTokens ?? 0) > config.protocol.budgets.maxReportedTotalTokens
		)
			failureReasons.push(
				`TOKEN_BUDGET_EXCEEDED: ${parsed!.reportedTotalTokens}>${config.protocol.budgets.maxReportedTotalTokens}`,
			);
		const failureReason = failureReasons.length === 0 ? undefined : failureReasons.join(' | ');
		return {
			argv: [config.executable, ...argv],
			environmentNames: Object.keys(environment).sort(),
			environmentValueFingerprints,
			status,
			signal,
			timedOut,
			durationMs,
			stdout,
			stderr,
			stdoutSha256: sha256(stdout),
			stderrSha256: sha256(stderr),
			toolCalls: parsed?.toolCalls ?? 0,
			reportedTotalTokens: parsed?.reportedTotalTokens ?? 0,
			guesslessInvocations: parsed?.guesslessInvocations ?? 0,
			spawnProvenance,
			...(parsed?.terminal === undefined ? {} : { terminal: parsed.terminal }),
			...(failureReason === undefined ? {} : { failureReason }),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
