#!/usr/bin/env node
// build-query.mjs -- emit a guessless query document from a file list + request JSON.
//
// Usage:
//   node build-query.mjs --root <repoRoot> --files <fileListPath> --request <requestJsonPath> [--out <path>]
//
// The file list is one repo-relative path per line (blank lines and #-comments ignored).
// Each listed file is read verbatim from <repoRoot>/<path> and supplied as an input with
// `path` set to exactly the repo-relative string, so the engine sees the same file set the
// ground-truth audit was computed over.
//
// The repo root is only ever read from. This script never writes into it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1) {
		if (fallback === undefined) throw new Error(`missing --${name}`);
		return fallback;
	}
	return process.argv[i + 1];
}

const root = arg('root');
const filesPath = arg('files');
const requestPath = arg('request');
const out = arg('out', '-');

const paths = readFileSync(filesPath, 'utf8')
	.split('\n')
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith('#'));

const inputs = paths.map((p) => ({ path: p, source: readFileSync(join(root, p), 'utf8') }));
const request = JSON.parse(readFileSync(requestPath, 'utf8'));

const doc = JSON.stringify({ inputs, request });
if (out === '-') process.stdout.write(doc);
else writeFileSync(out, doc);
