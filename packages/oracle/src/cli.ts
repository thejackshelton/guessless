#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { acquire } from './acquire.ts';
import { calibrateEvidence, recordEvidence, repairEvidence, verifyEvidence } from './evidence.ts';
import { runPerformanceWorker, serializePerformanceRecord } from './performance.ts';

async function main(args: readonly string[]): Promise<void> {
	const [command, ...rest] = args;
	if (command === 'acquire') {
		await acquire(rest);
		return;
	}
	if (command === 'performance-worker') {
		const lines = Number(rest[0]);
		process.stdout.write(serializePerformanceRecord(runPerformanceWorker(lines)));
		return;
	}
	if (command === 'record') {
		await recordEvidence(rest, fileURLToPath(import.meta.url));
		return;
	}
	if (command === 'repair') {
		await repairEvidence(rest, fileURLToPath(import.meta.url));
		return;
	}
	if (command === 'verify') {
		verifyEvidence(rest);
		return;
	}
	if (command === 'calibrate') {
		calibrateEvidence(rest);
		return;
	}
	throw new Error(`unknown oracle command '${command ?? ''}'`);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(
		`guessless-oracle: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
