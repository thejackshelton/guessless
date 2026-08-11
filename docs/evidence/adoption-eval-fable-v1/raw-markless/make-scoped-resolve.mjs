#!/usr/bin/env node
// make-scoped-resolve.mjs <refsReceipt.json> <resultIndex> <file> <name> <space> <outRequest.json>
// Uses an engine-produced reference-site anchor as the `scope` of a resolveBinding request,
// so a function-local binding can be reached without hand-authoring an anchor.
import { readFileSync, writeFileSync } from 'node:fs';

const [receiptPath, index, file, name, space, outPath] = process.argv.slice(2);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const scope = receipt.results[Number(index)].site;
writeFileSync(
	outPath,
	`${JSON.stringify({ kind: 'resolveBinding', file, name, space, scope }, null, '\t')}\n`,
);
