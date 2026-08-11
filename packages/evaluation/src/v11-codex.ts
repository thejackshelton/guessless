import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	V11_BUDGETS,
	V11_CODEX_VERSION,
	V11_MODEL,
	V11_POLICY,
	sha256,
	stableJson,
	type V11Cell,
} from './v11-contracts.ts';

export interface V11JsonlEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface V11DeliveryAccounting {
	readonly starts: number;
	readonly cancellations: number;
	readonly deliveredResults: number;
	readonly deliveredApplicablePrepare: number;
	readonly deliveredApplicableImpact: number;
	readonly proofReads: number;
	readonly toolCalls: number;
	readonly reportedTokens: number;
	readonly durationMs: number;
}

export interface V11TranscriptInspection {
	readonly events: readonly V11JsonlEvent[];
	readonly accounting: V11DeliveryAccounting;
	readonly finalText: string;
	readonly failed: boolean;
	readonly diagnostics: number;
}

function itemOf(event: V11JsonlEvent): Record<string, unknown> | null {
	return event.item !== null && typeof event.item === 'object' && !Array.isArray(event.item)
		? (event.item as Record<string, unknown>)
		: null;
}

function toolIdentity(item: Record<string, unknown>): string | null {
	if (item.type === 'mcp_tool_call') {
		const server = typeof item.server === 'string' ? item.server : 'mcp';
		const tool = typeof item.tool === 'string' ? item.tool : null;
		return tool === null ? null : `${server}/${tool}`;
	}
	if (['command_execution', 'file_change', 'web_search'].includes(String(item.type)))
		return `${String(item.type)}/${String(item.id ?? '')}`;
	return null;
}

function usageTokens(event: V11JsonlEvent): number {
	const usage =
		event.usage !== null && typeof event.usage === 'object' && !Array.isArray(event.usage)
			? (event.usage as Record<string, unknown>)
			: {};
	const total = Number(usage.total_tokens);
	if (Number.isSafeInteger(total) && total >= 0) return total;
	const input = Number(usage.input_tokens ?? 0);
	const output = Number(usage.output_tokens ?? 0);
	return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
		? input + output
		: Number.NaN;
}

export function parseV11Jsonl(jsonl: string, durationMs: number): V11TranscriptInspection {
	const events = jsonl
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as V11JsonlEvent);
	let starts = 0;
	let cancellations = 0;
	let deliveredResults = 0;
	let deliveredApplicablePrepare = 0;
	let deliveredApplicableImpact = 0;
	let proofReads = 0;
	let terminal = 0;
	let reportedTokens = Number.NaN;
	let finalText = '';
	let failed = false;
	let diagnostics = 0;
	const pending = new Map<string, string>();
	for (const event of events) {
		const item = itemOf(event);
		const tool = item === null ? null : toolIdentity(item);
		if (
			terminal > 0 &&
			tool !== null &&
			(event.type === 'item.started' || event.type === 'item.completed')
		)
			throw new Error('v11 tool lifecycle follows terminal turn');
		if (event.type === 'item.started' && item !== null) {
			if (tool !== null) {
				const id = String(item.id ?? '');
				if (id.length === 0 || pending.has(id)) throw new Error('v11 duplicate tool start');
				pending.set(id, tool);
				starts += 1;
			}
		}
		if (event.type === 'item.completed' && item !== null) {
			if (item.type === 'agent_message' && typeof item.text === 'string')
				finalText = item.text;
			if (tool !== null) {
				const id = String(item.id ?? '');
				if (pending.get(id) !== tool) throw new Error('v11 delivery lacks matching start');
				pending.delete(id);
				if (item.status === 'failed' || item.status === 'cancelled') cancellations += 1;
				else {
					deliveredResults += 1;
					if (tool.endsWith('/guessless_prepare_snapshot'))
						deliveredApplicablePrepare += 1;
					if (tool.endsWith('/guessless_safe_change_impact'))
						deliveredApplicableImpact += 1;
					if (tool.endsWith('/guessless_safe_change_page')) proofReads += 1;
				}
			}
		}
		if (event.type === 'turn.completed' || event.type === 'turn.failed') {
			terminal += 1;
			if (terminal > 1) throw new Error('v11 multiple terminal turns');
			failed ||= event.type === 'turn.failed';
			reportedTokens = usageTokens(event);
			if (event.type === 'turn.failed' && !Number.isSafeInteger(reportedTokens))
				reportedTokens = 0;
		}
		if (event.type === 'error') diagnostics += 1;
	}
	if (terminal !== 1) throw new Error('v11 JSONL requires exactly one turn terminal');
	if (pending.size !== 0) throw new Error('v11 JSONL contains undelivered tool starts');
	for (const [label, value, maximum] of [
		['tools', starts, V11_BUDGETS.perCell.maxToolCalls],
		['tokens', reportedTokens, V11_BUDGETS.perCell.maxReportedTokens],
		['duration', durationMs, V11_BUDGETS.perCell.timeoutMs],
	] as const)
		if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
			throw new Error(`v11 ${label} budget exceeded`);
	return {
		events,
		accounting: {
			starts,
			cancellations,
			deliveredResults,
			deliveredApplicablePrepare,
			deliveredApplicableImpact,
			proofReads,
			toolCalls: starts,
			reportedTokens,
			durationMs,
		},
		finalText,
		failed,
		diagnostics,
	};
}

export function persistAndParseV11(
	stdout: string,
	stderr: string,
	stdoutPath: string,
	stderrPath: string,
	durationMs: number,
): V11TranscriptInspection {
	writeFileSync(stdoutPath, stdout, { flag: 'wx' });
	writeFileSync(stderrPath, stderr, { flag: 'wx' });
	return parseV11Jsonl(stdout, durationMs);
}

export interface V11SpawnRequest {
	readonly cell: V11Cell;
	readonly prompt: string;
	readonly answerDirectory: string;
	readonly sealSchemaPath: string;
	readonly corpusRoot: string;
	readonly mcpServerPath: string;
	readonly nodeExecutable: string;
	readonly codexExecutable: string;
	readonly codexHome: string;
	readonly production: boolean;
	readonly stdoutPath: string;
	readonly stderrPath: string;
}

export interface V11SpawnResult {
	readonly command: readonly string[];
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly inspection: V11TranscriptInspection;
}

export async function spawnV11Cell(request: V11SpawnRequest): Promise<V11SpawnResult> {
	const args = [
		'exec',
		'--model',
		V11_MODEL,
		'--json',
		'--ephemeral',
		'--ignore-user-config',
		'--ignore-rules',
		'--skip-git-repo-check',
		'--sandbox',
		'workspace-write',
		'--cd',
		request.answerDirectory,
		'--output-schema',
		request.sealSchemaPath,
		'--output-last-message',
		join(request.answerDirectory, 'seal.json'),
		'-c',
		'shell_environment_policy.inherit="none"',
	];
	if (request.production) {
		const command = `cd ${JSON.stringify(request.corpusRoot)} && exec ${JSON.stringify(request.nodeExecutable)} ${JSON.stringify(request.mcpServerPath)}`;
		args.push(
			'-c',
			'mcp_servers.guessless.command="/bin/sh"',
			'-c',
			`mcp_servers.guessless.args=${JSON.stringify(['-c', command])}`,
		);
	}
	args.push('-');
	const started = performance.now();
	let stdout = '';
	let stderr = '';
	let observedStarts = 0;
	let buffered = '';
	let killedForCap = false;
	const child = spawn(request.codexExecutable, args, {
		cwd: request.answerDirectory,
		env: {
			PATH: process.env.PATH,
			CODEX_HOME: request.codexHome,
			HOME: join(request.answerDirectory, 'home'),
			LANG: 'C.UTF-8',
			LC_ALL: 'C.UTF-8',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const timeout = setTimeout(() => child.kill('SIGTERM'), V11_BUDGETS.perCell.timeoutMs);
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
		buffered += chunk;
		const lines = buffered.split('\n');
		buffered = lines.pop() ?? '';
		for (const line of lines) {
			try {
				const event = JSON.parse(line) as V11JsonlEvent;
				if (event.type === 'item.started' && toolIdentity(itemOf(event) ?? {}) !== null) {
					observedStarts += 1;
					if (observedStarts > V11_BUDGETS.perCell.maxToolCalls) {
						killedForCap = true;
						child.kill('SIGTERM');
					}
				}
			} catch {
				// The complete parser rejects malformed JSONL after process termination.
			}
		}
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	child.stdin.end(request.prompt);
	const { exitCode, signal } = await new Promise<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
	clearTimeout(timeout);
	const durationMs = Math.ceil(performance.now() - started);
	const inspection = persistAndParseV11(
		stdout,
		stderr,
		request.stdoutPath,
		request.stderrPath,
		durationMs,
	);
	if (killedForCap) throw new Error('v11 tool cap stopped cell');
	return {
		command: [request.codexExecutable, ...args],
		stdout,
		stderr,
		exitCode,
		signal,
		inspection,
	};
}

export interface V11ReplayRecord {
	readonly cellId: string;
	readonly status: 'completed' | 'unrun';
	readonly accounting: V11DeliveryAccounting | null;
	readonly reason?: string;
}

export interface V11SealedReplay {
	readonly schema: 'guessless.v11-sealed-replay/v1';
	readonly outcome: 'complete' | 'partial-NO_GO';
	readonly records: readonly V11ReplayRecord[];
	readonly integrity: string;
}

export function sealV11Replay(
	order: readonly V11Cell[],
	completed: readonly V11ReplayRecord[],
	failure?: string,
): V11SealedReplay {
	if (order.length !== V11_POLICY.cellCount)
		throw new Error('v11 frozen order must contain 1 cell');
	const records: V11ReplayRecord[] = [...completed];
	if (failure !== undefined)
		for (const cell of order.slice(completed.length))
			records.push({
				cellId: cell.id,
				status: 'unrun',
				accounting: null,
				reason: 'completion-impossible',
			});
	if (records.length !== order.length) throw new Error('v11 replay is not terminal');
	const unsigned = {
		schema: 'guessless.v11-sealed-replay/v1' as const,
		outcome: failure === undefined ? ('complete' as const) : ('partial-NO_GO' as const),
		records,
	};
	return { ...unsigned, integrity: sha256(stableJson(unsigned)) };
}

export function fakeV11Preflight(order: readonly V11Cell[]): {
	allSuccess: V11SealedReplay;
	firstFailure: V11SealedReplay;
	spawnedOnFailure: 1;
	unrunOnFailure: number;
} {
	const accounting: V11DeliveryAccounting = {
		starts: 0,
		cancellations: 0,
		deliveredResults: 0,
		deliveredApplicablePrepare: 0,
		deliveredApplicableImpact: 0,
		proofReads: 0,
		toolCalls: 0,
		reportedTokens: 1,
		durationMs: 1,
	};
	const all = order.map((cell) => ({
		cellId: cell.id,
		status: 'completed' as const,
		accounting,
	}));
	const first = [{ cellId: order[0]!.id, status: 'completed' as const, accounting }];
	return {
		allSuccess: sealV11Replay(order, all),
		firstFailure: sealV11Replay(order, first, 'injected'),
		spawnedOnFailure: 1,
		unrunOnFailure: order.length - 1,
	};
}

export function readFinalSeal(answerDirectory: string): unknown {
	return JSON.parse(readFileSync(join(answerDirectory, 'seal.json'), 'utf8'));
}

export function assertCodexVersion(versionOutput: string): void {
	if (versionOutput.trim().split(/\s+/).at(-1) !== V11_CODEX_VERSION)
		throw new Error('v11 Codex version mismatch');
}
