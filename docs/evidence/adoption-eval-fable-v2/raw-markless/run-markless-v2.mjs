// Re-runs every adoption-eval-fable-v1 markless query (q00-q21) against the engine at HEAD.
//
// Inputs are rebuilt exactly as in v1: the ordered input path list and the verbatim request
// recorded per receipt in
//   docs/evidence/adoption-eval-fable-v1/raw-markless/query-index.json
// Set A/B files are read verbatim from the read-only markless checkout; the three `probe/`
// documents (q19-q21) are reconstructed by the same rules as v1's make-unparsed-probe.mjs and
// make-unparsed-dependent-probe.mjs (documented inline below).
//
// Writes only inside docs/evidence/adoption-eval-fable-v2/raw-markless/ (+ a scratch dir for the
// 2.2 MB query documents, which v1 also declined to check in). Never writes to markless.
//
// Usage: node docs/evidence/adoption-eval-fable-v2/raw-markless/run-markless-v2.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const V1 = join(REPO, 'docs', 'evidence', 'adoption-eval-fable-v1', 'raw-markless');
const MARKLESS = '/Users/jacksm5pro/dev/open-source/markless';

const index = JSON.parse(readFileSync(join(V1, 'query-index.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'guessless-v2-markless-'));

// --- probe reconstruction (identical rules to v1's probe scripts) ---------------------------
const appTsrx = readFileSync(`${MARKLESS}/demos/live-feed/src/App.tsrx`, 'utf8');
const probeSources = {
	// make-unparsed-probe.mjs: verbatim .tsrx source under a .ts path + hand-written shim.
	'q19-unparsed-tsrx-source': {
		'probe/App-as-ts.ts': appTsrx,
		'probe/main-shim.ts': "import App from './App-as-ts.ts';\nexport const mounted = App;\n",
	},
	// make-unparsed-dependent-probe.mjs: same .tsrx source with its single import specifier
	// rewritten './update-feed' -> './update-feed.ts' so the two supplied paths link.
	dependent: {
		'probe/App-as-ts.ts': appTsrx.replace("from './update-feed'", "from './update-feed.ts'"),
		'probe/update-feed.ts': readFileSync(
			`${MARKLESS}/demos/live-feed/src/update-feed.ts`,
			'utf8',
		),
	},
};
probeSources['q20-unparsed-dependent-resolve'] = probeSources.dependent;
probeSources['q21-unparsed-dependent-refs'] = probeSources.dependent;

function sourceFor(id, path) {
	if (path.startsWith('probe/')) {
		const bag = probeSources[id];
		if (!bag || !(path in bag)) throw new Error(`no probe source for ${id} ${path}`);
		return bag[path];
	}
	return readFileSync(join(MARKLESS, path), 'utf8');
}

const timings = [];
const outIndex = {};

for (const [id, entry] of Object.entries(index)) {
	const inputs = entry.inputs.map((path) => ({ path, source: sourceFor(id, path) }));
	const doc = { inputs, request: entry.request };
	const docPath = join(scratch, `${id}.query.json`);
	writeFileSync(docPath, JSON.stringify(doc));

	const started = process.hrtime.bigint();
	let stdout;
	let stderr = '';
	let exitCode = 0;
	try {
		stdout = execFileSync('node', [CLI, 'query', docPath], {
			encoding: 'utf8',
			maxBuffer: 1 << 28,
		});
	} catch (error) {
		stdout = error.stdout ?? '';
		stderr = error.stderr ?? '';
		exitCode = error.status ?? 1;
	}
	const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
	writeFileSync(join(HERE, `${id}.receipt.json`), stdout);
	const receipt = JSON.parse(stdout);

	const v1Receipt = JSON.parse(readFileSync(join(V1, `${id}.receipt.json`), 'utf8'));
	timings.push({
		id,
		inputFiles: inputs.length,
		query: receipt.query,
		state: receipt.state,
		v1State: v1Receipt.state,
		results: Array.isArray(receipt.results) ? receipt.results.length : null,
		v1Results: Array.isArray(v1Receipt.results) ? v1Receipt.results.length : null,
		unresolved: Array.isArray(receipt.unresolved) ? receipt.unresolved.length : null,
		v1Unresolved: Array.isArray(v1Receipt.unresolved) ? v1Receipt.unresolved.length : null,
		wallMs: Number(wallMs.toFixed(1)),
		receiptBytes: Buffer.byteLength(stdout, 'utf8'),
		v1ReceiptBytes: Buffer.byteLength(readFileSync(join(V1, `${id}.receipt.json`))),
		snapshot: receipt.snapshot ?? null,
		v1Snapshot: v1Receipt.snapshot ?? null,
		snapshotMatchesV1: (receipt.snapshot ?? null) === (v1Receipt.snapshot ?? null),
		exitCode,
	});
	outIndex[id] = {
		inputs: entry.inputs,
		request: entry.request,
		snapshot: receipt.snapshot ?? null,
		state: receipt.state,
	};
	if (stderr) process.stderr.write(`[${id}] ${stderr}`);
}

writeFileSync(join(HERE, 'query-index.json'), `${JSON.stringify(outIndex, null, 1)}\n`);
writeFileSync(join(HERE, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
console.table(
	timings.map((t) => ({
		id: t.id,
		state: `${t.v1State}->${t.state}`,
		results: `${t.v1Results}->${t.results}`,
		unresolved: `${t.v1Unresolved}->${t.unresolved}`,
		snapOk: t.snapshotMatchesV1,
	})),
);
