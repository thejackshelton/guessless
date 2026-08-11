#!/usr/bin/env node
// make-unparsed-probe.mjs <outQueryDoc.json>
// Synthetic boundary probe. Feeds the VERBATIM source of a real markless .tsrx file
// (demos/live-feed/src/App.tsrx) under a `.ts` path, so the engine's parser actually
// sees Markless syntax instead of refusing on the extension alone, and pairs it with a
// hand-written but syntactically valid `.ts` importer. This is the only synthetic input
// in the trial; every other query uses markless files verbatim under their real paths.
import { readFileSync, writeFileSync } from 'node:fs';

const MARKLESS = '/Users/jacksm5pro/dev/open-source/markless';
const [outPath] = process.argv.slice(2);

const inputs = [
	{
		path: 'probe/App-as-ts.ts',
		source: readFileSync(`${MARKLESS}/demos/live-feed/src/App.tsrx`, 'utf8'),
	},
	{
		path: 'probe/main-shim.ts',
		source: "import App from './App-as-ts.ts';\nexport const mounted = App;\n",
	},
];

const request = {
	kind: 'resolveBinding',
	file: 'probe/main-shim.ts',
	name: 'App',
	space: 'value',
	scope: null,
};

writeFileSync(outPath, JSON.stringify({ inputs, request }));
