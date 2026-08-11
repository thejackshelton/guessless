#!/usr/bin/env node
// make-unparsed-dependent-probe.mjs <outQueryDoc.json>
//
// The sharpest boundary question: when a CALLER cannot be parsed, does referencesOf on the
// callee still claim `complete`?
//
// Inputs are two real markless files, verbatim:
//   demos/live-feed/src/update-feed.ts  -- exports fetchLocalUpdates, parses fine
//   demos/live-feed/src/App.tsrx        -- calls fetchLocalUpdates, does NOT parse as TS
// App.tsrx is supplied under a `.ts` path so the engine parses it rather than refusing the
// whole batch on extension (see q14/q15/q16, which show extension refusal). Its import
// specifier is rewritten from './update-feed' to './update-feed.ts' ONLY so the two supplied
// paths link; no other byte of either file is altered.
//
// Ground truth over this input set: fetchLocalUpdates has 2 references outside its own
// declaration -- the import specifier and the call, both inside the unparseable module.
import { readFileSync, writeFileSync } from 'node:fs';

const MARKLESS = '/Users/jacksm5pro/dev/open-source/markless';
const [outPath] = process.argv.slice(2);

const app = readFileSync(`${MARKLESS}/demos/live-feed/src/App.tsrx`, 'utf8').replace(
	"from './update-feed'",
	"from './update-feed.ts'",
);

const inputs = [
	{ path: 'probe/App-as-ts.ts', source: app },
	{
		path: 'probe/update-feed.ts',
		source: readFileSync(`${MARKLESS}/demos/live-feed/src/update-feed.ts`, 'utf8'),
	},
];

const request = {
	kind: 'resolveBinding',
	file: 'probe/update-feed.ts',
	name: 'fetchLocalUpdates',
	space: 'value',
	scope: null,
};

writeFileSync(outPath, JSON.stringify({ inputs, request }));
