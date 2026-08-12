// Scores every adoption-eval-fable-v2 receipt against the hand-audited ground truth published in
// the v1 reports (docs/evidence/adoption-eval-fable-v1/{markless,versionless}-report.md).
//
// Ground truth below is transcribed verbatim from those tables; nothing is re-derived. Site kinds
// are collapsed to three classes so that receipt sites can be matched mechanically:
//   import      -- import specifier (ImportSpecifier / ImportDefaultSpecifier)
//   reexport    -- re-export specifier carrying a `from` source
//   use         -- everything else that is a real occurrence of the binding, including local
//                  `export { X }` specifiers and type-position uses
// plus two write-only classes used by writesOf ground truth:
//   mutation    -- mutation through a method call on the binding (`x.push(...)`)
//   escape      -- the binding passed by reference into a callee that mutates it
//
// A ground-truth site counts as RETURNED if a receipt result matches it on (file, class), and as
// NAMED if it is not returned but the receipt carries at least one `unresolved` entry sited in the
// same file (the attribution convention used by the v1 reports, e.g. v1 markless q02 counted
// import specifiers in JSX-broken files as named by those files' `unparsed-file` diagnostics).
// MISSED-AND-UNNAMED is neither. SPURIOUS is a result with no ground-truth counterpart.
//
// Usage: node docs/evidence/adoption-eval-fable-v2/score.mjs   (writes scores.json, prints table)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Set GL_BUNDLE to score a different evidence bundle with the identical rule — used to recompute
// the v1 numbers under the same contract, so the v1->v2 comparison is like-for-like:
//   GL_BUNDLE=../adoption-eval-fable-v1 GL_SCORES=scores-v1-recomputed.json node score.mjs
const BUNDLE = process.env.GL_BUNDLE ? join(HERE, process.env.GL_BUNDLE) : HERE;
const SCORES = process.env.GL_SCORES ?? 'scores.json';

const s = (file, cls, n = 1) => Array.from({ length: n }, () => ({ file, cls }));

// --------------------------------------------------------------------------- markless ground truth
const M = 'packages/serializer/src/';
const MARKLESS = {
	'q00-resolve-isvalidstoragekey': { kind: 'anchor', gt: 1 },
	'q00-resolve-serializegraphvalue': { kind: 'anchor', gt: 1 },
	'q00-resolve-asyncboundaryarm': { kind: 'anchor', gt: 1 },
	'q01-refs-isvalidstoragekey': {
		kind: 'sites',
		gt: [
			...s(`${M}storage-slot.ts`, 'reexport'),
			...s(`${M}protocol-validation-storage.ts`, 'import'),
			...s(`${M}protocol-validation-storage.ts`, 'use'),
			...s(`${M}storage-record-client.ts`, 'import'),
			...s(`${M}storage-record-client.ts`, 'use'),
		],
	},
	'q02-refs-serializegraphvalue': {
		kind: 'sites',
		gt: [
			...s(`${M}protocol-state.ts`, 'import'),
			...s(`${M}protocol-state.ts`, 'use', 3),
			...s(`${M}resume-record-delta.ts`, 'import'),
			...s(`${M}resume-record-delta.ts`, 'use'),
		],
	},
	'q03-refs-asyncboundaryarm': {
		kind: 'sites',
		gt: [
			...s(`${M}protocol.ts`, 'import'),
			...s(`${M}protocol.ts`, 'use', 3),
			...s(`${M}protocol-validation.ts`, 'import'),
			...s(`${M}protocol-validation.ts`, 'use'),
		],
	},
	'q04-writes-serializegraphvalue': { kind: 'sites', gt: [] },
	'q04b-writes-asyncboundaryarm': { kind: 'sites', gt: [] },
	'q05-exportednames-storage-slot': {
		kind: 'names',
		gt: [
			'isValidStorageKey',
			'STORAGE_SLOT_SYMBOL_KEY',
			'storageAttributeName',
			'StorageSeedMetadata',
			'storageSlotEntryKey',
			'storageSlotEntryKeyFromGraphNodeId',
			'createStorageSeedMetadata',
			'createStorageSeedMetadataFromGraphNodeId',
		],
	},
	'q06-resolve-encodeslot': { kind: 'anchor', gt: 1 },
	'q06b-refs-encodeslot': { kind: 'sites', gt: s(`${M}value.ts`, 'use', 7) },
	'q07-resolve-records': { kind: 'anchor', gt: 1 },
	'q08-refs-records': { kind: 'sites', gt: s(`${M}value.ts`, 'use', 24) },
	'q09-reads-records': { kind: 'sites', gt: s(`${M}value.ts`, 'use', 24) },
	// v1 markless report §1 D1: 10 `records.push(...)` mutations plus 7 by-reference escapes,
	// "All 17 mutation-bearing sites are missing and none is named."
	'q10-writes-records': {
		kind: 'sites',
		gt: [...s(`${M}value.ts`, 'mutation', 10), ...s(`${M}value.ts`, 'escape', 7)],
	},
	'q11-resolve-index': { kind: 'anchor', gt: 1 },
	'q12-refs-index': { kind: 'sites', gt: s(`${M}value.ts`, 'use', 3) },
	'q13-writes-index': { kind: 'sites', gt: s(`${M}value.ts`, 'use', 1) },
	'q14-tsrx-exportednames-app': { kind: 'refusal' },
	'q15-tsrx-exportednames-main': { kind: 'refusal' },
	'q16-tsrx-resolve-app-in-main': { kind: 'refusal' },
	'q17-tsrx-omitted-exportednames-main': { kind: 'names', gt: [] },
	'q18-tsrx-omitted-resolve-app': { kind: 'anchor', gt: 1 },
	'q19-unparsed-tsrx-source': { kind: 'anchor', gt: 1 },
	'q20-unparsed-dependent-resolve': { kind: 'anchor', gt: 1 },
	'q21-unparsed-dependent-refs': {
		kind: 'sites',
		gt: [...s('probe/App-as-ts.ts', 'import'), ...s('probe/App-as-ts.ts', 'use')],
	},
};

// ------------------------------------------------------------------------ versionless ground truth
const pair = (file) => [...s(file, 'import'), ...s(file, 'use')];
const VERSIONLESS = {
	'q01-resolve-loadRepos': { kind: 'anchor', gt: 1 },
	'q02-references-loadRepos': {
		kind: 'sites',
		gt: [
			...pair('containers/App/tests/actions.test.js'),
			...pair('containers/App/tests/reducer.test.js'),
			...pair('containers/HomePage/index.js'),
			...pair('containers/HomePage/tests/index.test.js'),
		],
	},
	'q03-resolve-makeSelectUsername': { kind: 'anchor', gt: 1 },
	'q04-references-makeSelectUsername': {
		kind: 'sites',
		gt: [
			...s('containers/HomePage/selectors.js', 'use'),
			...pair('containers/HomePage/index.js'),
			...pair('containers/HomePage/saga.js'),
			...pair('containers/HomePage/tests/selectors.test.js'),
		],
	},
	'q05-resolve-LOAD_REPOS': { kind: 'anchor', gt: 1 },
	'q06-references-LOAD_REPOS': {
		kind: 'sites',
		gt: [
			...pair('containers/App/actions.js'),
			...pair('containers/App/reducer.js'),
			...pair('containers/App/tests/actions.test.js'),
			...pair('containers/HomePage/saga.js'),
			...pair('containers/HomePage/tests/saga.test.js'),
		],
	},
	'q07-resolve-getRepos': { kind: 'anchor', gt: 1 },
	'q08-reachableFrom-getRepos': { kind: 'count', gt: 11 },
	'q09-reaches-getRepos': { kind: 'count', gt: 0 },
	'q10-exportednames-app-selectors': {
		kind: 'names',
		gt: [
			'selectGlobal',
			'makeSelectCurrentUser',
			'makeSelectLoading',
			'makeSelectError',
			'makeSelectRepos',
			'makeSelectLocation',
		],
	},
	'q11-exportednames-i18n-cjs': {
		kind: 'names',
		gt: ['appLocales', 'formatTranslationMessages', 'translationMessages', 'DEFAULT_LOCALE'],
		namedIn: 'i18n.js',
	},
	'q12-exportednames-homepage-saga': { kind: 'names', gt: ['getRepos', 'default'] },
	'q13-definitionOf-makeSelectUsername': { kind: 'count', gt: 1 },
	'q14-resolve-plugins': { kind: 'anchor', gt: 1 },
	'q15-writesOf-plugins': {
		kind: 'sites',
		gt: [
			...s('internals/scripts/extract-intl.js', 'mutation'),
			...s('internals/scripts/extract-intl.js', 'use'),
		],
	},
	'q16-readsOf-plugins': { kind: 'sites', gt: s('internals/scripts/extract-intl.js', 'use', 3) },
	'q17-resolve-progress': { kind: 'anchor', gt: 1 },
	'q18-writesOf-progress': { kind: 'sites', gt: s('internals/scripts/extract-intl.js', 'use', 1) },
	'q19-resolve-LOAD_REPOS-reporooted': { kind: 'anchor', gt: 1 },
	'q20-references-LOAD_REPOS-reporooted': {
		kind: 'sites',
		gt: [
			...pair('app/containers/App/actions.js'),
			...pair('app/containers/App/reducer.js'),
			...pair('app/containers/App/tests/actions.test.js'),
			...pair('app/containers/HomePage/saga.js'),
			...pair('app/containers/HomePage/tests/saga.test.js'),
		],
	},
	'q21-resolve-actions-array-nested': { kind: 'count', gt: 0 },
	'q22-resolve-reposLoaded': { kind: 'anchor', gt: 1 },
	'q23-references-reposLoaded': {
		kind: 'sites',
		gt: [
			...pair('containers/App/tests/actions.test.js'),
			...pair('containers/App/tests/reducer.test.js'),
			...pair('containers/HomePage/saga.js'),
			...pair('containers/HomePage/tests/saga.test.js'),
		],
	},
	'q24-resolve-reposLoaded-relativised': { kind: 'anchor', gt: 1 },
	'q25-references-reposLoaded-relativised': {
		kind: 'sites',
		gt: [
			...pair('containers/App/tests/actions.test.js'),
			...pair('containers/App/tests/reducer.test.js'),
			...pair('containers/HomePage/saga.js'),
			...pair('containers/HomePage/tests/saga.test.js'),
		],
	},
};

function classOf(site) {
	const head = site.semanticPath?.[0] ?? '';
	if (head === 'site:import-specifier') return 'import';
	if (head === 'site:reexport-specifier') return 'reexport';
	return 'use';
}

function scoreOne(dir, id, spec) {
	const receipt = JSON.parse(readFileSync(join(BUNDLE, dir, `${id}.receipt.json`), 'utf8'));
	const unresolved = receipt.unresolved ?? [];
	const unresolvedFiles = new Set(unresolved.map((u) => u.site?.file));
	const row = {
		id,
		state: receipt.state,
		results: Array.isArray(receipt.results) ? receipt.results.length : 0,
		unresolved: unresolved.length,
		gt: null,
		returned: 0,
		named: 0,
		missedUnnamed: 0,
		spurious: 0,
		detail: [],
	};

	if (spec.kind === 'refusal') {
		row.gt = 'n/a';
		row.ok = receipt.state === 'refused';
		return row;
	}
	if (spec.kind === 'anchor' || spec.kind === 'count') {
		row.gt = spec.gt;
		row.returned = row.results;
		row.missedUnnamed = Math.max(0, spec.gt - row.results);
		row.spurious = Math.max(0, row.results - spec.gt);
		return row;
	}
	if (spec.kind === 'names') {
		const got = new Set(receipt.results.map((r) => r.name));
		row.gt = spec.gt.length;
		// An absent export name only counts as NAMED when an unresolved entry actually concerns an
		// export construct in that file. Import/require boundaries in the same file do not account
		// for a missing export -- that leniency is exactly what the v1 versionless report refused
		// for q11, and refusing it here keeps the v1/v2 recomputation comparable.
		const exportEntries = unresolved.filter(
			(u) => u.site?.file === (spec.namedIn ?? '') && u.reason === 'unrecognized-export-form',
		);
		for (const name of spec.gt) {
			if (got.has(name)) row.returned += 1;
			else if (exportEntries.some((u) => (u.detail ?? '').includes(name))) {
				row.named += 1;
				row.detail.push(`named:${name}|by=unrecognized-export-form`);
			} else {
				row.missedUnnamed += 1;
				row.detail.push(`MISSED:${name}`);
			}
		}
		for (const name of got) if (!spec.gt.includes(name)) row.spurious += 1;
		return row;
	}

	// spec.kind === 'sites'
	const pool = new Map(); // `${file}|${cls}` -> count
	for (const r of receipt.results) {
		const key = `${r.site.file}|${classOf(r.site)}`;
		pool.set(key, (pool.get(key) ?? 0) + 1);
	}
	row.gt = spec.gt.length;
	for (const site of spec.gt) {
		// mutation/escape ground truth can only be matched by an unresolved entry, never by a
		// writesOf result (the engine models assignment-only writes).
		const matchKey = `${site.file}|${site.cls === 'mutation' || site.cls === 'escape' ? 'use' : site.cls}`;
		if (site.cls !== 'mutation' && site.cls !== 'escape' && (pool.get(matchKey) ?? 0) > 0) {
			pool.set(matchKey, pool.get(matchKey) - 1);
			row.returned += 1;
			continue;
		}
		if (site.cls === 'mutation') {
			// a mutation site is named when the receipt carries a method-call-mutation-uncertain
			// entry in that file; count them one-for-one.
			const left = unresolved.filter(
				(u) => u.site?.file === site.file && u.reason === 'method-call-mutation-uncertain',
			).length;
			const used = row.detail.filter((d) => d === `mutation-named:${site.file}`).length;
			if (used < left) {
				row.named += 1;
				row.detail.push(`mutation-named:${site.file}`);
			} else {
				row.missedUnnamed += 1;
				row.detail.push(`MISSED-mutation:${site.file}`);
			}
			continue;
		}
		if (site.cls === 'escape') {
			// Symmetric with the `mutation` branch above, and held to the identical
			// standard: an escape site counts as named only when the receipt carries
			// its own `argument-escape-mutation-uncertain` entry in that file, matched
			// one-for-one. Seven ground-truth escapes still need seven distinct
			// entries; a file that carries one entry cannot cover all seven.
			//
			// This branch previously hardcoded `missedUnnamed`, because when the
			// scorer was written no closed reason could name an escape at all — the
			// engine had no vocabulary for it, so no receipt could earn the credit.
			// The reason now exists (D5), so the rule is applied rather than the
			// verdict assumed. Nothing was loosened: the v1 bundle scored through
			// this same code still counts all 7 as missed, because v1 receipts carry
			// no such entry — the two columns stay a like-for-like comparison.
			const left = unresolved.filter(
				(u) =>
					u.site?.file === site.file &&
					u.reason === 'argument-escape-mutation-uncertain',
			).length;
			const used = row.detail.filter((d) => d === `escape-named:${site.file}`).length;
			if (used < left) {
				row.named += 1;
				row.detail.push(`escape-named:${site.file}`);
			} else {
				row.missedUnnamed += 1;
				row.detail.push(`MISSED-escape:${site.file}`);
			}
			continue;
		}
		if (unresolvedFiles.has(site.file)) {
			const reasons = [
				...new Set(unresolved.filter((u) => u.site?.file === site.file).map((u) => u.reason)),
			];
			row.named += 1;
			row.detail.push(`named:${site.file}|${site.cls}|by=${reasons.join('+')}`);
		} else {
			row.missedUnnamed += 1;
			row.detail.push(`MISSED:${site.file}|${site.cls}`);
		}
	}
	for (const [, n] of pool) row.spurious += n;
	return row;
}

const out = { markless: [], versionless: [] };
for (const [id, spec] of Object.entries(MARKLESS)) out.markless.push(scoreOne('raw-markless', id, spec));
for (const [id, spec] of Object.entries(VERSIONLESS))
	out.versionless.push(scoreOne('raw-versionless', id, spec));

const all = [...out.markless, ...out.versionless];
out.totals = {
	queries: all.length,
	missedUnnamed: all.reduce((n, r) => n + r.missedUnnamed, 0),
	spurious: all.reduce((n, r) => n + r.spurious, 0),
	named: all.reduce((n, r) => n + r.named, 0),
	returned: all.reduce((n, r) => n + r.returned, 0),
};
out.totals.oracleZeroMissedAndUnnamed = out.totals.missedUnnamed === 0;

writeFileSync(join(HERE, SCORES), `${JSON.stringify(out, null, 2)}\n`);
console.table(
	all.map((r) => ({
		id: r.id,
		state: r.state,
		gt: r.gt,
		returned: r.returned,
		named: r.named,
		missedUnnamed: r.missedUnnamed,
		spurious: r.spurious,
	})),
);
console.log(out.totals);
for (const r of all) {
	const bad = r.detail.filter((d) => d.startsWith('MISSED'));
	if (bad.length) console.log(r.id, bad);
}
