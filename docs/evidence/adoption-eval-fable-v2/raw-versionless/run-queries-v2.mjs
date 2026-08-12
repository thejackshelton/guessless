// Re-runs the adoption-eval-fable-v1 versionless honesty trial (q01-q25) against the engine at
// HEAD. Byte-for-byte the same harness as
//   docs/evidence/adoption-eval-fable-v1/raw-versionless/run-queries.mjs
// except that (a) the fixture is read from the v1 evidence directory (read-only) and (b) the
// receipts/requests/timings are written here, into the v2 bundle. Same input sets, same request
// shapes, same anchor-derivation rule (targets are lifted from the engine's own resolveBinding
// results, never hand-authored).
//
// Usage: node docs/evidence/adoption-eval-fable-v2/raw-versionless/run-queries-v2.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const V1 = join(REPO, 'docs', 'evidence', 'adoption-eval-fable-v1', 'raw-versionless');
const FIXTURE = join(V1, 'fixture', 'react-boilerplate-d19099afeff64ecfb09133c06c1cb18c0d40887e');

const setA = JSON.parse(readFileSync(join(V1, 'inputset.json'), 'utf8'));

function inputs(root, files) {
  return files.map((path) => ({
    path,
    source: readFileSync(join(FIXTURE, root, path), 'utf8'),
  }));
}

const SET_A = inputs('app', setA.files);
const SET_B = setA.files.map((path) => ({
  path: `app/${path}`,
  source: readFileSync(join(FIXTURE, 'app', path), 'utf8'),
}));
const SET_C = inputs('.', ['internals/scripts/extract-intl.js']);
const SET_D = inputs('.', ['internals/generators/language/index.js']);

const SETS = { 'SET-A': SET_A, 'SET-B': SET_B, 'SET-C': SET_C, 'SET-D': SET_D };

const timings = [];

function run(id, setName, request) {
  const doc = { inputs: SETS[setName], request };
  writeFileSync(join(HERE, `${id}.request.json`), `${JSON.stringify(doc.request, null, 2)}\n`);
  const payload = JSON.stringify(doc);
  const started = process.hrtime.bigint();
  let stdout;
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [CLI, 'query', '-'], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch (error) {
    stdout = error.stdout ?? '';
    exitCode = error.status ?? 1;
    process.stderr.write(`[${id}] exit ${exitCode}: ${error.stderr ?? ''}\n`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const bytes = Buffer.byteLength(stdout, 'utf8');
  writeFileSync(join(HERE, `${id}.receipt.json`), stdout);
  const receipt = JSON.parse(stdout);
  const v1 = JSON.parse(readFileSync(join(V1, `${id}.receipt.json`), 'utf8'));
  timings.push({
    id,
    inputSet: setName,
    inputFiles: SETS[setName].length,
    query: request.kind,
    state: receipt.state,
    v1State: v1.state,
    results: Array.isArray(receipt.results) ? receipt.results.length : null,
    v1Results: Array.isArray(v1.results) ? v1.results.length : null,
    unresolved: Array.isArray(receipt.unresolved) ? receipt.unresolved.length : null,
    v1Unresolved: Array.isArray(v1.unresolved) ? v1.unresolved.length : null,
    wallMs: Number(elapsedMs.toFixed(1)),
    receiptBytes: bytes,
    v1ReceiptBytes: Buffer.byteLength(readFileSync(join(V1, `${id}.receipt.json`))),
    snapshot: receipt.snapshot ?? null,
    snapshotMatchesV1: (receipt.snapshot ?? null) === (v1.snapshot ?? null),
    exitCode,
  });
  return receipt;
}

const anchorOf = (receipt) => receipt.results[0];

const q01 = run('q01-resolve-loadRepos', 'SET-A', {
  kind: 'resolveBinding',
  file: 'containers/App/actions.js',
  name: 'loadRepos',
  space: 'value',
  scope: null,
});
run('q02-references-loadRepos', 'SET-A', { kind: 'referencesOf', target: anchorOf(q01) });

const q03 = run('q03-resolve-makeSelectUsername', 'SET-A', {
  kind: 'resolveBinding',
  file: 'containers/HomePage/selectors.js',
  name: 'makeSelectUsername',
  space: 'value',
  scope: null,
});
run('q04-references-makeSelectUsername', 'SET-A', { kind: 'referencesOf', target: anchorOf(q03) });

const q05 = run('q05-resolve-LOAD_REPOS', 'SET-A', {
  kind: 'resolveBinding',
  file: 'containers/App/constants.js',
  name: 'LOAD_REPOS',
  space: 'value',
  scope: null,
});
run('q06-references-LOAD_REPOS', 'SET-A', { kind: 'referencesOf', target: anchorOf(q05) });

const q07 = run('q07-resolve-getRepos', 'SET-A', {
  kind: 'resolveBinding',
  file: 'containers/HomePage/saga.js',
  name: 'getRepos',
  space: 'value',
  scope: null,
});
run('q08-reachableFrom-getRepos', 'SET-A', { kind: 'reachableFrom', target: anchorOf(q07) });
run('q09-reaches-getRepos', 'SET-A', { kind: 'reaches', target: anchorOf(q07) });

run('q10-exportednames-app-selectors', 'SET-A', {
  kind: 'exportedNames',
  file: 'containers/App/selectors.js',
});
run('q11-exportednames-i18n-cjs', 'SET-A', { kind: 'exportedNames', file: 'i18n.js' });
run('q12-exportednames-homepage-saga', 'SET-A', {
  kind: 'exportedNames',
  file: 'containers/HomePage/saga.js',
});

run('q13-definitionOf-makeSelectUsername', 'SET-A', {
  kind: 'definitionOf',
  target: anchorOf(q03),
});

const q14 = run('q14-resolve-plugins', 'SET-C', {
  kind: 'resolveBinding',
  file: 'internals/scripts/extract-intl.js',
  name: 'plugins',
  space: 'value',
  scope: null,
});
run('q15-writesOf-plugins', 'SET-C', { kind: 'writesOf', target: anchorOf(q14) });
run('q16-readsOf-plugins', 'SET-C', { kind: 'readsOf', target: anchorOf(q14) });

const q17 = run('q17-resolve-progress', 'SET-C', {
  kind: 'resolveBinding',
  file: 'internals/scripts/extract-intl.js',
  name: 'progress',
  space: 'value',
  scope: null,
});
run('q18-writesOf-progress', 'SET-C', { kind: 'writesOf', target: anchorOf(q17) });

run('q21-resolve-actions-array-nested', 'SET-D', {
  kind: 'resolveBinding',
  file: 'internals/generators/language/index.js',
  name: 'actions',
  space: 'value',
  scope: null,
});

const q19 = run('q19-resolve-LOAD_REPOS-reporooted', 'SET-B', {
  kind: 'resolveBinding',
  file: 'app/containers/App/constants.js',
  name: 'LOAD_REPOS',
  space: 'value',
  scope: null,
});
run('q20-references-LOAD_REPOS-reporooted', 'SET-B', {
  kind: 'referencesOf',
  target: anchorOf(q19),
});

const q22 = run('q22-resolve-reposLoaded', 'SET-A', {
  kind: 'resolveBinding',
  file: 'containers/App/actions.js',
  name: 'reposLoaded',
  space: 'value',
  scope: null,
});
run('q23-references-reposLoaded', 'SET-A', { kind: 'referencesOf', target: anchorOf(q22) });

const RELATIVISE = {
  'containers/HomePage/saga.js': {
    "'containers/App/actions'": "'../App/actions'",
    "'containers/App/constants'": "'../App/constants'",
    "'containers/HomePage/selectors'": "'./selectors'",
  },
  'containers/HomePage/tests/saga.test.js': {
    "'containers/App/actions'": "'../../App/actions'",
    "'containers/App/constants'": "'../../App/constants'",
  },
};
const SET_E = SET_A.map((entry) => {
  const rules = RELATIVISE[entry.path];
  if (!rules) return entry;
  let source = entry.source;
  for (const [from, to] of Object.entries(rules)) source = source.split(from).join(to);
  return { path: entry.path, source };
});
SETS['SET-E'] = SET_E;
const q24 = run('q24-resolve-reposLoaded-relativised', 'SET-E', {
  kind: 'resolveBinding',
  file: 'containers/App/actions.js',
  name: 'reposLoaded',
  space: 'value',
  scope: null,
});
run('q25-references-reposLoaded-relativised', 'SET-E', {
  kind: 'referencesOf',
  target: anchorOf(q24),
});

writeFileSync(join(HERE, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
console.table(
  timings.map((t) => ({
    id: t.id,
    state: `${t.v1State}->${t.state}`,
    results: `${t.v1Results}->${t.results}`,
    unresolved: `${t.v1Unresolved}->${t.unresolved}`,
    snapOk: t.snapshotMatchesV1,
  })),
);
