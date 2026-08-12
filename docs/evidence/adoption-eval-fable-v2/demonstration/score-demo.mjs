// score-demo.mjs — mechanical scoring of the must-have demonstration.
//
// Reads only checked-in artifacts (ground truth, receipts, timings, sealed v1/v2 receipts), so it
// re-runs anywhere without the markless corpus. Writes scores.json. Exits non-zero unless all of
// P1-P5 hold and no falsifier F1-F5 fired.
//
// Site granularity: engine anchors carry semantic paths, not line numbers, so results are compared
// to ground truth per file, by occurrence count. That is exact here: in every file that mentions
// either symbol, exactly one binding of that name is in scope (see ground-truth-*.json `route`),
// so "n occurrences of the name in file F" and "n sites of that binding in F" are the same set.
//
// Usage: node docs/evidence/adoption-eval-fable-v2/demonstration/score-demo.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const V1 = join(HERE, '..', '..', 'adoption-eval-fable-v1', 'raw-markless');
const V2 = join(HERE, '..', 'raw-markless');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

const BUDGET_MS = 10 * 60 * 1000;

// The sealed v1 q03 ground truth for ASYNC_BOUNDARY_ARM (adoption-eval-fable-v1/markless-report.md
// section 5, "Ground truth - 7 occurrences"): occurrence 1 is the declaration, occurrences 2-7 are
// the six reference sites inside packages/serializer/**.
const SEALED_Q03_SITES = [
	{ file: 'packages/serializer/src/protocol.ts', line: 1 },
	{ file: 'packages/serializer/src/protocol.ts', line: 4 },
	{ file: 'packages/serializer/src/protocol.ts', line: 6 },
	{ file: 'packages/serializer/src/protocol.ts', line: 6 },
	{ file: 'packages/serializer/src/protocol-validation.ts', line: 2 },
	{ file: 'packages/serializer/src/protocol-validation.ts', line: 301 },
];

const symbols = [
	{ id: 'S1', groundTruth: 'ground-truth-S1.json', receipt: 'S1-q01-refs-deserializegraphvalue.receipt.json', resolve: 'S1-q00-resolve-deserializegraphvalue.receipt.json' },
	{ id: 'S2', groundTruth: 'ground-truth-S2.json', receipt: 'S2-q01-refs-async_boundary_arm.receipt.json', resolve: 'S2-q00-resolve-async_boundary_arm.receipt.json' },
];

const timings = read(join(HERE, 'timings.json'));
const perSymbol = {};

for (const symbol of symbols) {
	const ground = read(join(HERE, symbol.groundTruth));
	const receipt = read(join(HERE, symbol.receipt));
	const resolveReceipt = read(join(HERE, symbol.resolve));
	const results = receipt.results ?? [];
	const unresolved = receipt.unresolved ?? [];

	const expectedByFile = ground.targetSitesByFile;
	const decoyFiles = [...new Set(ground.sites.filter((s) => s.class.startsWith('decoy')).map((s) => s.file))];

	const gotByFile = {};
	for (const result of results) gotByFile[result.site.file] = (gotByFile[result.site.file] ?? 0) + 1;

	// --- P1: no decoy site, and no result beyond the audited target sites of a file -------------
	const decoyHitsInResults = results.filter((r) => decoyFiles.includes(r.site.file)).length;
	const spurious = [];
	for (const [file, got] of Object.entries(gotByFile)) {
		const expected = expectedByFile[file] ?? 0;
		if (got > expected) spurious.push({ file, expected, got });
	}
	const p1 = decoyHitsInResults === 0 && spurious.length === 0;

	// --- P2: no silent miss ---------------------------------------------------------------------
	const namedFiles = new Set(
		unresolved
			.filter((u) => typeof u.reason === 'string' && typeof u.detail === 'string' && u.detail.length > 0)
			.map((u) => u.site.file),
	);
	// The specifier each file actually reaches the target binding through, taken from the hand audit.
	const routeSpecifier = {};
	for (const site of ground.sites) {
		const match = /'([^']+)'/.exec(site.route ?? '');
		if (match !== null) routeSpecifier[site.file] = match[1];
	}

	const missed = [];
	for (const [file, expected] of Object.entries(expectedByFile)) {
		const got = gotByFile[file] ?? 0;
		if (got >= expected) continue;
		const namingEntries = unresolved.filter((u) => u.site.file === file);
		const specifier = routeSpecifier[file] ?? null;
		// Stricter diagnostic than P2 requires: does any entry name the *specifier the target is
		// reached through*, or only some unrelated failing import in the same file?
		const namesRouteSpecifier =
			specifier !== null && namingEntries.some((u) => u.detail.includes(`'${specifier}'`));
		missed.push({
			file,
			expected,
			returned: got,
			missing: expected - got,
			named: namedFiles.has(file),
			routeSpecifier: specifier,
			namesRouteSpecifier,
			namedBy: namingEntries.slice(0, 2).map((u) => ({ reason: u.reason, detail: u.detail })),
		});
	}
	const silent = missed.filter((m) => !m.named);
	const silentSites = silent.reduce((n, m) => n + m.missing, 0);
	const p2 = silentSites === 0;

	// --- P3: full coverage inside packages/serializer/** -----------------------------------------
	const serializerExpected = Object.entries(expectedByFile).filter(([f]) => f.startsWith('packages/serializer/'));
	const serializerCoverage = serializerExpected.map(([file, expected]) => ({
		file,
		expected,
		returned: gotByFile[file] ?? 0,
	}));
	const serializerExpectedTotal = serializerCoverage.reduce((n, c) => n + c.expected, 0);
	const serializerReturnedTotal = serializerCoverage.reduce((n, c) => n + Math.min(c.returned, c.expected), 0);
	let sealedOk = true;
	let sealedDetail = 'n/a (sealed q03 ground truth covers S2 only)';
	if (symbol.id === 'S2') {
		const auditedSerializerSrc = ground.sites
			.filter((s) => s.file.startsWith('packages/serializer/src/') && s.class === 'target')
			.map((s) => `${s.file}:${s.line}`)
			.sort();
		const sealed = SEALED_Q03_SITES.map((s) => `${s.file}:${s.line}`).sort();
		const auditAgreesWithSealed = JSON.stringify(auditedSerializerSrc) === JSON.stringify(sealed);
		const returnedSerializerSrc = results.filter((r) => r.site.file.startsWith('packages/serializer/src/')).length;
		sealedOk = auditAgreesWithSealed && returnedSerializerSrc === SEALED_Q03_SITES.length;
		sealedDetail = `hand audit ${auditAgreesWithSealed ? 'agrees with' : 'DISAGREES with'} the sealed 6 q03 sites; engine returned ${returnedSerializerSrc}/6 in packages/serializer/src/`;
	}
	const p3 = serializerExpectedTotal === serializerReturnedTotal && sealedOk;

	// --- P4: grep provably cannot partition (decoy hits in the word-boundary baseline) ----------
	const p4 = ground.counts.baselineDecoyHits > 0;

	perSymbol[symbol.id] = {
		symbol: ground.symbol,
		anchorSource: 'resolveBinding (engine-derived; no hand-authored anchor)',
		anchorsFromResolve: (resolveReceipt.results ?? []).length,
		receiptState: receipt.state,
		baseline: {
			command: ground.baseline.command,
			tool: ground.baseline.tool,
			hitLines: ground.baseline.hitLines,
			baselineTrueHits: ground.counts.baselineTrueHits,
			baselineDecoyHits: ground.counts.baselineDecoyHits,
			partition: 'none — grep returns the undifferentiated union',
		},
		groundTruth: {
			occurrences: ground.counts.occurrences,
			targetReferenceSites: ground.counts.targetReferenceSites,
			decoySites: ground.counts.decoySites,
		},
		guessless: {
			results: results.length,
			unresolvedEntries: unresolved.length,
			filesNamedInUnresolved: namedFiles.size,
			decoyHitsInResults,
			spurious,
			missedFiles: missed,
			silentlyMissedFiles: silent.map((m) => m.file),
			silentlyMissedSites: silentSites,
			missedSites: missed.reduce((n, m) => n + m.missing, 0),
			missedSitesNamedByRouteSpecifier: missed
				.filter((m) => m.namesRouteSpecifier)
				.reduce((n, m) => n + m.missing, 0),
			missedSitesNamedOnlyIncidentally: missed
				.filter((m) => m.named && !m.namesRouteSpecifier)
				.reduce((n, m) => n + m.missing, 0),
		},
		serializerScope: { coverage: serializerCoverage, expected: serializerExpectedTotal, returned: serializerReturnedTotal, sealed: sealedDetail },
		checks: { P1: p1, P2: p2, P3: p3, P4: p4 },
	};
}

// --- P5: wall clock ----------------------------------------------------------------------------
const p5 = timings.totalWallMs <= BUDGET_MS;

// --- F4: answer stability inside the sealed serializer scope -----------------------------------
const sealedV2 = read(join(V2, 'q03-refs-asyncboundaryarm.receipt.json'));
const sealedV1 = read(join(V1, 'q03-refs-asyncboundaryarm.receipt.json'));
const bigS2 = read(join(HERE, 'S2-q01-refs-async_boundary_arm.receipt.json'));
const anchorKey = (r) => `${r.site.file}|${r.site.semanticPath.join('>')}|${r.site.fingerprint}|${r.access}`;
const bigSerializerSrc = bigS2.results.filter((r) => r.site.file.startsWith('packages/serializer/src/')).map(anchorKey).sort();
const sealedV2Keys = sealedV2.results.map(anchorKey).sort();
const sealedV1Keys = sealedV1.results.map(anchorKey).sort();
const stableVsV2 = JSON.stringify(bigSerializerSrc) === JSON.stringify(sealedV2Keys);
const v1Subset = sealedV1Keys.every((k) => bigSerializerSrc.includes(k));
const targetAnchorStable = JSON.stringify(bigS2.request.target) === JSON.stringify(sealedV2.request.target);

const checks = {
	P1: Object.values(perSymbol).every((s) => s.checks.P1),
	P2: Object.values(perSymbol).every((s) => s.checks.P2),
	P3: Object.values(perSymbol).every((s) => s.checks.P3),
	P4: perSymbol.S1.checks.P4,
	P5: p5,
};

const falsifiers = [];
if (!checks.P1) {
	for (const [id, s] of Object.entries(perSymbol))
		if (!s.checks.P1)
			falsifiers.push({ id: 'F1', symbol: id, detail: `decoy or over-returned sites in results: ${s.guessless.decoyHitsInResults} decoy, ${JSON.stringify(s.guessless.spurious)}` });
}
if (!checks.P2) {
	for (const [id, s] of Object.entries(perSymbol))
		if (!s.checks.P2)
			falsifiers.push({
				id: 'F2',
				symbol: id,
				detail: `${s.guessless.silentlyMissedSites} ground-truth site(s) of '${s.symbol}' are neither returned nor named anywhere in the receipt: ${s.guessless.silentlyMissedFiles.join(', ')}`,
			});
}
if (perSymbol.S1.baseline.baselineDecoyHits === 0 && perSymbol.S2.baseline.baselineDecoyHits === 0)
	falsifiers.push({ id: 'F3', detail: 'word-boundary grep yields zero decoy hits for both symbols' });
if (!(stableVsV2 && v1Subset && targetAnchorStable))
	falsifiers.push({ id: 'F4', detail: 'the 635-file input changed an answer inside the sealed v1/v2 serializer scope' });
if (!p5) falsifiers.push({ id: 'F5', detail: `prepare+queries took ${timings.totalWallMs} ms > ${BUDGET_MS} ms budget` });

const pass = Object.values(checks).every(Boolean) && falsifiers.length === 0;

const scores = {
	schema: 'guessless.demonstration.scores/v1',
	verdict: pass ? 'PASS' : 'FALSIFIED',
	corpus: timings.corpus,
	checks,
	falsifiers,
	timing: { totalWallMs: timings.totalWallMs, totalQueryMs: timings.totalQueryMs, budgetMs: BUDGET_MS, P5: p5 },
	stability: {
		bigRunSerializerSrcSites: bigSerializerSrc.length,
		sealedV2Sites: sealedV2Keys.length,
		sealedV1Sites: sealedV1Keys.length,
		identicalToSealedV2: stableVsV2,
		sealedV1IsSubset: v1Subset,
		targetAnchorIdenticalToSealed: targetAnchorStable,
	},
	symbols: perSymbol,
};
writeFileSync(join(HERE, 'scores.json'), `${JSON.stringify(scores, null, 1)}\n`);

console.log(`verdict: ${scores.verdict}`);
for (const [name, ok] of Object.entries(checks)) console.log(`  ${name}: ${ok ? 'pass' : 'FAIL'}`);
for (const f of falsifiers) console.log(`  ${f.id}${f.symbol ? ` (${f.symbol})` : ''}: ${f.detail}`);
process.exit(pass ? 0 : 1);
