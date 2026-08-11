// Builds a guessless query document from the markless serializer package.
// Usage: node build.mjs '<request json>' > query.json
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = '/Users/jacksm5pro/dev/open-source/markless/packages/serializer';

function walk(dir, out = []) {
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name)) out.push(full);
	}
	return out;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'test'))];
const inputs = files.map((f) => ({
	path: relative(ROOT, f),
	source: readFileSync(f, 'utf8'),
}));

const request = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({ inputs, request }));
