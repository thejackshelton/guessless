#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { executeCommand, type CliExecution } from './index.ts';

export function main(argv: readonly string[]): CliExecution {
	if (argv.length !== 2)
		return {
			stdout: '',
			stderr: 'guessless: expected exactly `query|reproduce <path|->`\n',
			exitCode: 2,
		};
	const [command, path] = argv as [string, string];
	if (command !== 'query' && command !== 'reproduce')
		return {
			stdout: '',
			stderr: `guessless: unknown command '${command}'\n`,
			exitCode: 2,
		};
	try {
		const document = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
		return executeCommand(command, document);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { stdout: '', stderr: `guessless: ${detail}\n`, exitCode: 2 };
	}
}

const execution = main(process.argv.slice(2));
process.stdout.write(execution.stdout);
process.stderr.write(execution.stderr);
process.exitCode = execution.exitCode;
