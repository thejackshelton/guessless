import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { GuesslessEvidence } from './corpus.ts';
import { networkIsolatedCommand } from './contracts.ts';

export interface McplsEvidence {
	readonly repository: string;
	readonly command: readonly string[];
	readonly networkIsolation: string;
	readonly config: string;
	readonly workspace: string;
	readonly position: GuesslessEvidence['comparisonPosition'];
	readonly transcript: readonly {
		readonly direction: 'stdin' | 'stdout';
		readonly raw: string;
	}[];
	readonly stderr: string;
	readonly definition: unknown;
	readonly references: unknown;
	readonly diagnostics: unknown;
	readonly usefulSuccess: boolean;
	readonly honestLimitation: string;
}

class McpClient {
	readonly transcript: { direction: 'stdin' | 'stdout'; raw: string }[] = [];
	readonly stderr: string[] = [];
	readonly process: ChildProcessWithoutNullStreams;
	readonly lines: Interface;
	#id = 0;
	#queue: ((line: string) => void)[] = [];

	constructor(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) {
		this.process = spawn(command[0], command.slice(1), {
			cwd,
			env: environment,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.lines = createInterface({ input: this.process.stdout });
		this.lines.on('line', (line) => {
			this.transcript.push({ direction: 'stdout', raw: line });
			this.#queue.shift()?.(line);
		});
		this.process.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()));
	}

	async request(method: string, params: unknown): Promise<unknown> {
		const request = { jsonrpc: '2.0', id: ++this.#id, method, params };
		const raw = JSON.stringify(request);
		this.transcript.push({ direction: 'stdin', raw });
		const response = new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() =>
					reject(new Error(`mcpls ${method} timed out; stderr=${this.stderr.join('')}`)),
				90_000,
			);
			this.#queue.push((line) => {
				clearTimeout(timeout);
				resolve(line);
			});
		});
		this.process.stdin.write(`${raw}\n`);
		const parsed = JSON.parse(await response) as { result?: unknown; error?: unknown };
		if (parsed.error !== undefined)
			throw new Error(`mcpls ${method}: ${JSON.stringify(parsed.error)}`);
		return parsed.result;
	}

	notify(method: string, params: unknown): void {
		const raw = JSON.stringify({ jsonrpc: '2.0', method, params });
		this.transcript.push({ direction: 'stdin', raw });
		this.process.stdin.write(`${raw}\n`);
	}

	async close(): Promise<void> {
		this.process.stdin.end();
		this.process.kill('SIGTERM');
		await new Promise<void>((resolve) => {
			if (this.process.exitCode !== null) resolve();
			else this.process.once('exit', () => resolve());
		});
		this.lines.close();
	}
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function resultContent(value: unknown): unknown {
	if (value !== null && typeof value === 'object' && 'content' in value)
		return (value as { content: unknown }).content;
	return value;
}

export function hasNonEmptyContent(value: unknown): boolean {
	const content = resultContent(value);
	if (Array.isArray(content))
		return content.some((item) => {
			if (item !== null && typeof item === 'object' && 'text' in item)
				return String((item as { text: unknown }).text).trim().length > 2;
			return true;
		});
	return content !== null && content !== undefined && JSON.stringify(content) !== '[]';
}

export async function recordMcpls(
	repository: string,
	workspace: string,
	position: GuesslessEvidence['comparisonPosition'],
	mcplsBinary: string,
	typescriptLanguageServer: string,
): Promise<McplsEvidence> {
	const scratch = mkdtempSync(join(tmpdir(), `guessless-mcpls-${repository}-`));
	const configPath = join(scratch, 'mcpls.toml');
	const extension = position.file.slice(position.file.lastIndexOf('.') + 1);
	const language =
		extension === 'tsx'
			? 'typescriptreact'
			: extension === 'jsx'
				? 'javascriptreact'
				: ['ts', 'mts', 'cts'].includes(extension)
					? 'typescript'
					: 'javascript';
	const config = [
		'[workspace]',
		`roots = [${tomlString(workspace)}]`,
		'position_encodings = ["utf-8", "utf-16"]',
		'',
		'[[workspace.language_extensions]]',
		`extensions = [${tomlString(extension)}]`,
		`language_id = ${tomlString(language)}`,
		'',
		'[[lsp_servers]]',
		`language_id = ${tomlString(language)}`,
		`command = ${tomlString(typescriptLanguageServer)}`,
		'args = ["--stdio"]',
		`file_patterns = [${tomlString(`**/*.${extension}`)}]`,
		'timeout_seconds = 60',
		'',
	].join('\n');
	writeFileSync(configPath, config, { flag: 'wx' });
	const isolated = networkIsolatedCommand(
		[mcplsBinary, '--config', configPath, '--log-level', 'info'],
		scratch,
	);
	const command = isolated.command;
	const client = new McpClient(command, scratch, {
		...process.env,
		GUESSLESS_ORACLE_NETWORK_CONSENT: 'disabled',
		HOME: scratch,
		TMPDIR: scratch,
	});
	try {
		await client.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'guessless-oracle', version: 'oracle-part-2-v1' },
		});
		client.notify('notifications/initialized', {});
		const args = {
			file_path: join(workspace, position.file),
			line: position.line,
			character: position.character,
		};
		const definition = await client.request('tools/call', {
			name: 'get_definition',
			arguments: args,
		});
		const references = await client.request('tools/call', {
			name: 'get_references',
			arguments: { ...args, include_declaration: true },
		});
		let diagnostics: unknown;
		try {
			diagnostics = await client.request('tools/call', {
				name: 'get_diagnostics',
				arguments: { file_path: join(workspace, position.file) },
			});
		} catch (error) {
			diagnostics = {
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const usefulSuccess = hasNonEmptyContent(definition) || hasNonEmptyContent(references);
		const diagnosticContent = JSON.stringify(resultContent(diagnostics));
		const honestLimitation = hasNonEmptyContent(diagnostics)
			? `typescript-language-server diagnostic/failure preserved verbatim: ${diagnosticContent}`
			: 'typescript-language-server returned no diagnostics for the selected file; this is not ground-truth validation';
		return {
			repository,
			command,
			networkIsolation: isolated.mechanism,
			config,
			workspace,
			position,
			transcript: client.transcript,
			stderr: client.stderr.join(''),
			definition,
			references,
			diagnostics,
			usefulSuccess,
			honestLimitation,
		};
	} finally {
		await client.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}
