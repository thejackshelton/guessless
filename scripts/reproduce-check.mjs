#!/usr/bin/env node
/**
 * guessless reproduce-check — the CI half of the claim gate.
 *
 * The Stop hook (`scripts/claim-gate.mjs`) only checks that a completeness claim *cites* a receipt
 * and that the receipt's own state supports the claim. It deliberately does no cryptography: a hook
 * has to be fast and must never fail a developer's turn because a build was stale.
 *
 * This script is where the claim is actually settled. For every receipt committed to a repository it
 * re-runs the query that produced it, on the exact inputs it was produced from, and demands the
 * canonical form come back byte-identical. A receipt whose integrity hash was hand-edited, whose
 * results were trimmed, or whose inputs have drifted since it was recorded fails here.
 *
 * ## Bundles
 *
 *   foo.receipt.json        The receipt as recorded. Human-readable evidence.
 *   foo.reproduction.json   { "inputs": [{ "path", "source" }], "receipt": <that receipt> }
 *
 * The reproduction bundle is what `guessless reproduce` consumes; it carries the sources so the
 * check does not depend on the surrounding repository still being in the state it was recorded from.
 * A `*.receipt.json` with no sibling `*.reproduction.json` cannot be re-run at all — it is reported
 * as unverifiable and fails the run unless `--allow-unverifiable` is passed, because a receipt no
 * one can reproduce is a screenshot, not evidence.
 *
 * ## Usage
 *
 *   node reproduce-check.mjs [paths...] [--allow-unverifiable] [--quiet]
 *
 * Paths may be directories (walked recursively) or individual `*.receipt.json` /
 * `*.reproduction.json` files. With no paths, the current working directory is walked. The guessless
 * CLI is located relative to *this file*, not the working directory, so a target repository can call
 * this script by absolute path from its own CI without vendoring guessless.
 *
 * Exit codes: 0 everything reproduced, 1 something did not, 2 the checker could not run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** The guessless workspace root, resolved from this file so absolute-path invocation works. */
export const guesslessRoot = resolve(scriptDir, '..');
export const cliPath = join(guesslessRoot, 'packages/cli/dist/cli.js');

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.guessless', 'coverage']);

const USAGE = `guessless reproduce-check

  reproduce-check.mjs [paths...] [options]

  paths                    Directories to walk, or individual *.receipt.json /
                           *.reproduction.json files. Defaults to the working directory.

  --allow-unverifiable     Report receipts with no reproduction bundle without failing.
  --quiet                  Only print failures and the final summary line.
  --help, -h               Show this message.

Exit codes: 0 all reproduced, 1 a receipt did not reproduce, 2 the checker could not run.
`;

/**
 * @typedef {object} Outcome
 * @property {'reproduced' | 'failed' | 'unverifiable'} status
 * @property {string} receipt Absolute path to the receipt.
 * @property {string} detail
 */

/**
 * @param {readonly string[]} argv
 * @returns {{ paths: string[], allowUnverifiable: boolean, quiet: boolean, help: boolean, unknown: string | null }}
 */
export function parseArgs(argv) {
	/** @type {string[]} */
	const paths = [];
	let allowUnverifiable = false;
	let quiet = false;
	let help = false;
	/** @type {string | null} */
	let unknown = null;
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') help = true;
		else if (arg === '--allow-unverifiable') allowUnverifiable = true;
		else if (arg === '--quiet') quiet = true;
		else if (arg.startsWith('--')) unknown = arg;
		else paths.push(arg);
	}
	return { paths, allowUnverifiable, quiet, help, unknown };
}

/**
 * Recursively collect every `*.receipt.json` beneath a directory.
 *
 * @param {string} directory
 * @param {string[]} into
 * @returns {void}
 */
function walk(directory, into) {
	/** @type {import('node:fs').Dirent[]} */
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRECTORIES.has(entry.name)) continue;
			walk(full, into);
		} else if (entry.isFile() && entry.name.endsWith('.receipt.json')) {
			into.push(full);
		}
	}
}

/**
 * Resolve the argument list into the set of receipts to check.
 *
 * A `*.reproduction.json` given directly is mapped back to its receipt, so pointing the checker at
 * either half of a bundle does the same thing.
 *
 * @param {readonly string[]} paths
 * @returns {string[]} Absolute receipt paths, sorted and de-duplicated.
 */
export function collectReceipts(paths) {
	/** @type {string[]} */
	const found = [];
	for (const path of paths) {
		const full = resolve(path);
		let stats;
		try {
			stats = statSync(full);
		} catch {
			throw new Error(`no such path: ${path}`);
		}
		if (stats.isDirectory()) walk(full, found);
		else if (full.endsWith('.receipt.json')) found.push(full);
		else if (full.endsWith('.reproduction.json'))
			found.push(full.replace(/\.reproduction\.json$/, '.receipt.json'));
		else throw new Error(`not a receipt or reproduction bundle: ${path}`);
	}
	return [...new Set(found)].sort();
}

/**
 * @param {string} receiptPath
 * @returns {string} The sibling reproduction bundle path (which may not exist).
 */
export function bundleFor(receiptPath) {
	return receiptPath.replace(/\.receipt\.json$/, '.reproduction.json');
}

/**
 * Re-run one reproduction bundle through the built guessless CLI.
 *
 * @param {string} receiptPath
 * @returns {Outcome}
 */
export function checkReceipt(receiptPath) {
	const bundle = bundleFor(receiptPath);
	if (!existsSync(bundle))
		return {
			status: 'unverifiable',
			receipt: receiptPath,
			detail: `no sibling ${basename(bundle)} — nothing to re-run this receipt against`,
		};
	try {
		execFileSync(process.execPath, [cliPath, 'reproduce', bundle], {
			cwd: guesslessRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { status: 'reproduced', receipt: receiptPath, detail: '' };
	} catch (error) {
		const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
		const code = typeof error?.status === 'number' ? error.status : 'unknown';
		return {
			status: 'failed',
			receipt: receiptPath,
			detail: stderr === '' ? `guessless reproduce exited ${code}` : stderr,
		};
	}
}

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function main(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (args.unknown !== null) {
		process.stderr.write(`reproduce-check: unknown option ${args.unknown}\n\n${USAGE}`);
		return 2;
	}
	if (!existsSync(cliPath)) {
		process.stderr.write(
			`reproduce-check: the guessless CLI is not built at ${cliPath}. ` +
				`Run \`pnpm build\` in ${guesslessRoot} first.\n`,
		);
		return 2;
	}

	/** @type {string[]} */
	let receipts;
	try {
		receipts = collectReceipts(args.paths.length === 0 ? [process.cwd()] : args.paths);
	} catch (error) {
		process.stderr.write(
			`reproduce-check: ${error instanceof Error ? error.message : error}\n`,
		);
		return 2;
	}
	if (receipts.length === 0) {
		process.stdout.write('reproduce-check: no *.receipt.json files found\n');
		return 0;
	}

	const outcomes = receipts.map((receipt) => checkReceipt(receipt));
	const reproduced = outcomes.filter((outcome) => outcome.status === 'reproduced');
	const failed = outcomes.filter((outcome) => outcome.status === 'failed');
	const unverifiable = outcomes.filter((outcome) => outcome.status === 'unverifiable');

	for (const outcome of outcomes) {
		if (outcome.status === 'reproduced') {
			if (!args.quiet) process.stdout.write(`  ok           ${outcome.receipt}\n`);
			continue;
		}
		const label = outcome.status === 'failed' ? 'FAILED      ' : 'unverifiable';
		process.stderr.write(`  ${label} ${outcome.receipt}\n                 ${outcome.detail}\n`);
	}

	const summary =
		`reproduce-check: ${reproduced.length} reproduced, ${failed.length} failed, ` +
		`${unverifiable.length} unverifiable\n`;
	const clean = failed.length === 0 && (unverifiable.length === 0 || args.allowUnverifiable);
	if (clean) process.stdout.write(summary);
	else process.stderr.write(summary);
	return clean ? 0 : 1;
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
