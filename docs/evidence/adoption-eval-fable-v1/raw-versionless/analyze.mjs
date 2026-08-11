// Summarises a receipt: result sites (file + tail of semanticPath) and unresolved
// entries grouped by (file, reason, detail). Usage:
//   node analyze.mjs <receipt-file> [...]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n===== ${basename(file)}  state=${r.state}  query=${r.query}`);
  const results = r.results ?? [];
  console.log(`-- results (${results.length})`);
  for (const item of results) {
    const site = item.site ?? item;
    const path = site.semanticPath ?? [];
    const tail = path.slice(-6).join(' > ');
    const extra = item.access ? ` access=${item.access}` : '';
    console.log(`   ${site.file ?? '(no file)'}  ...${tail}${extra}`);
  }
  const unresolved = r.unresolved ?? [];
  console.log(`-- unresolved (${unresolved.length})`);
  const groups = new Map();
  for (const u of unresolved) {
    const key = JSON.stringify([
      u.site.file,
      u.reason,
      u.detail,
      (u.site.semanticPath ?? []).slice(0, 5).join('>'),
    ]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of groups) {
    const [f, reason, detail, head] = JSON.parse(key);
    console.log(`   x${count}  ${f}  [${reason}] ${detail}   @${head}`);
  }
}
