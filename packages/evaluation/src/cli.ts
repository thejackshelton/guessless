#!/usr/bin/env node
import { calibrate, record, verify } from './evidence.ts';
import { runFakeOnlyPreflight } from './v6-codex.ts';
import { verifyV6Preregistration } from './v6-preregistration.ts';

const [command, ...args] = process.argv.slice(2);
try {
	if (command === 'record') record(args);
	else if (command === 'verify') verify(args);
	else if (command === 'calibrate') calibrate(args);
	else if (command === 'v6-verify-prereg') {
		if (args.length !== 0) throw new Error('v6-verify-prereg accepts no arguments');
		process.stdout.write(`${JSON.stringify(verifyV6Preregistration())}\n`);
	} else if (command === 'v6-preflight') {
		if (args.length !== 1 || args[0] !== '--fake')
			throw new Error('v6-preflight requires exactly --fake; live execution is unavailable');
		process.stdout.write(`${JSON.stringify(runFakeOnlyPreflight())}\n`);
	} else throw new Error(`unknown evaluation command '${command ?? ''}'`);
} catch (error) {
	process.stderr.write(
		`guessless-evaluation: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
