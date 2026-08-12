// run-demo.mjs — must-have demonstration: scope-resolved symbol truth at repo scale.
//
// Input set (mechanical, committed content only):
//   git -C <markless> ls-files '*.ts' | grep '^packages/'    (635 files)
// Every file's source is read from the *commit* 931f0544 via `git archive`, never from the
// markless working tree, so a dirty checkout cannot change the answer and nothing is written
// to the corpus.
//
// Queries, per target binding, anchors derived by the engine only (no hand-authored anchors):
//   1. resolveBinding(file, name, space=value, scope=null)  -> anchor
//   2. referencesOf(anchor from step 1)
//
// Writes only inside docs/evidence/adoption-eval-fable-v2/demonstration/ (+ an OS temp dir for
// the corpus extract and the ~9 MB query documents).
//
// Usage: node docs/evidence/adoption-eval-fable-v2/demonstration/run-demo.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// P5 measures prepare + query: the clock starts before the corpus is materialised.
const started = process.hrtime.bigint();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const MARKLESS = '/Users/jacksm5pro/dev/open-source/markless';
const COMMIT = '931f054444a41c0527dfa77f812fa49e87df3b8f';

const head = execFileSync('git', ['-C', MARKLESS, 'rev-parse', COMMIT], { encoding: 'utf8' }).trim();

// --- input set -------------------------------------------------------------------------------
const inputPaths = execFileSync('git', ['-C', MARKLESS, 'ls-files', '*.ts'], {
	encoding: 'utf8',
	maxBuffer: 1 << 28,
})
	.split('\n')
	.filter((p) => p.startsWith('packages/'));
inputPaths.sort();
writeFileSync(join(HERE, 'input-files.txt'), `${inputPaths.join('\n')}\n`);

// --- committed sources, extracted read-only out of the object database -------------------------
const scratch = mkdtempSync(join(tmpdir(), 'guessless-demo-'));
const corpus = join(scratch, 'corpus');
mkdirSync(corpus);
const tarPath = join(scratch, 'corpus.tar');
execFileSync('git', ['-C', MARKLESS, 'archive', COMMIT, '-o', tarPath, '--', ...inputPaths]);
execFileSync('tar', ['-x', '-f', tarPath, '-C', corpus]);

const inputs = inputPaths.map((path) => ({ path, source: readFileSync(join(corpus, path), 'utf8') }));
const corpusBytes = inputs.reduce((n, i) => n + Buffer.byteLength(i.source, 'utf8'), 0);

// --- queries ----------------------------------------------------------------------------------
const symbols = [
	{
		id: 'S1',
		name: 'deserializeGraphValue',
		file: 'packages/serializer/src/value-decode.ts',
	},
	{
		id: 'S2',
		name: 'ASYNC_BOUNDARY_ARM',
		file: 'packages/serializer/src/async-boundary-arm.ts',
	},
];

function runQuery(id, request) {
	const docPath = join(scratch, `${id}.query.json`);
	writeFileSync(docPath, JSON.stringify({ inputs, request }));
	const started = process.hrtime.bigint();
	let stdout;
	let stderr = '';
	let exitCode = 0;
	try {
		stdout = execFileSync('node', [CLI, 'query', docPath], { encoding: 'utf8', maxBuffer: 1 << 28 });
	} catch (error) {
		stdout = error.stdout ?? '';
		stderr = error.stderr ?? '';
		exitCode = error.status ?? 1;
	}
	const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
	rmSync(docPath, { force: true });
	writeFileSync(join(HERE, `${id}.receipt.json`), stdout);
	if (stderr) process.stderr.write(`[${id}] ${stderr}`);
	return {
		id,
		request,
		receipt: JSON.parse(stdout),
		wallMs: Number(wallMs.toFixed(1)),
		receiptBytes: Buffer.byteLength(stdout, 'utf8'),
		exitCode,
	};
}

const timings = [];
const queryIndex = {};
const prepareMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1));

for (const symbol of symbols) {
	const resolveId = `${symbol.id}-q00-resolve-${symbol.name.toLowerCase()}`;
	const resolved = runQuery(resolveId, {
		kind: 'resolveBinding',
		file: symbol.file,
		name: symbol.name,
		space: 'value',
		scope: null,
	});
	const anchors = resolved.receipt.results ?? [];
	if (anchors.length !== 1) {
		throw new Error(`${resolveId}: expected exactly 1 anchor, got ${anchors.length}`);
	}
	const refsId = `${symbol.id}-q01-refs-${symbol.name.toLowerCase()}`;
	const refs = runQuery(refsId, { kind: 'referencesOf', target: anchors[0] });

	for (const run of [resolved, refs]) {
		timings.push({
			id: run.id,
			symbol: symbol.id,
			inputFiles: inputs.length,
			query: run.receipt.query,
			state: run.receipt.state,
			results: Array.isArray(run.receipt.results) ? run.receipt.results.length : null,
			unresolved: Array.isArray(run.receipt.unresolved) ? run.receipt.unresolved.length : null,
			wallMs: run.wallMs,
			receiptBytes: run.receiptBytes,
			snapshot: run.receipt.snapshot ?? null,
			exitCode: run.exitCode,
		});
		queryIndex[run.id] = {
			symbol: symbol.id,
			inputFiles: inputs.length,
			inputList: 'input-files.txt',
			corpus: { repo: MARKLESS, commit: head, bytes: corpusBytes },
			request: run.request,
			snapshot: run.receipt.snapshot ?? null,
			state: run.receipt.state,
		};
	}
}

const totalQueryMs = timings.reduce((n, t) => n + t.wallMs, 0);
const totalWallMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1));

writeFileSync(join(HERE, 'query-index.json'), `${JSON.stringify(queryIndex, null, 1)}\n`);
writeFileSync(
	join(HERE, 'timings.json'),
	`${JSON.stringify(
		{
			corpus: { repo: MARKLESS, commit: head, inputFiles: inputs.length, bytes: corpusBytes },
			queries: timings,
			prepareMs,
			totalQueryMs: Number(totalQueryMs.toFixed(1)),
			totalWallMs,
			budgetMs: 10 * 60 * 1000,
		},
		null,
		2,
	)}\n`,
);
rmSync(scratch, { recursive: true, force: true });
console.table(timings.map((t) => ({ id: t.id, state: t.state, results: t.results, unresolved: t.unresolved, wallMs: t.wallMs })));
console.log(`total query wall: ${(totalQueryMs / 1000).toFixed(1)}s`);
