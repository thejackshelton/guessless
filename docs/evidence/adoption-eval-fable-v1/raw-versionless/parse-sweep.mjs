// Per-file parseability sweep over SET-A: one `exportedNames` query per input file,
// with the whole 35-file set supplied every time. Receipts land verbatim in
// raw-versionless/parse-sweep/. Usage: node parse-sweep.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', '..', 'packages', 'cli', 'dist', 'cli.js');
const FIXTURE = join(
  HERE,
  'fixture',
  'react-boilerplate-d19099afeff64ecfb09133c06c1cb18c0d40887e',
  'app',
);
const OUT = join(HERE, 'parse-sweep');
mkdirSync(OUT, { recursive: true });

const setA = JSON.parse(readFileSync(join(HERE, 'inputset.json'), 'utf8'));
const inputs = setA.files.map((path) => ({
  path,
  source: readFileSync(join(FIXTURE, path), 'utf8'),
}));

const rows = [];
for (const file of setA.files) {
  const payload = JSON.stringify({ inputs, request: { kind: 'exportedNames', file } });
  const stdout = execFileSync('node', [CLI, 'query', '-'], {
    input: payload,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  writeFileSync(join(OUT, `${file.replace(/[\\/]/g, '_')}.receipt.json`), stdout);
  const r = JSON.parse(stdout);
  const own = (r.unresolved ?? []).filter((u) => u.site.file === file);
  const parseDiagnostics = own.filter((u) => u.reason === 'unparsed-file');
  rows.push({
    file,
    hasJsx: /<\/|\/>/.test(inputs.find((i) => i.path === file).source),
    state: r.state,
    exportedNames: (r.results ?? []).map((x) => x.name).join(','),
    parseDiagnostics: parseDiagnostics.length,
    firstDiagnostic: parseDiagnostics[0]?.detail ?? '',
  });
}
writeFileSync(join(HERE, 'parse-sweep.json'), `${JSON.stringify(rows, null, 2)}\n`);
console.table(rows.map((r) => ({ ...r, exportedNames: r.exportedNames.slice(0, 40) })));
