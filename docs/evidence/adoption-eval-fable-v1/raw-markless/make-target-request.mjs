#!/usr/bin/env node
// make-target-request.mjs <resolveReceipt.json> <kind> <outRequest.json>
// Lifts results[0] (a symbol anchor) out of a resolveBinding receipt and writes
// { "kind": <kind>, "target": <anchor> } so the follow-up query targets exactly
// the binding the engine itself resolved -- no hand-written anchors.
import { readFileSync, writeFileSync } from 'node:fs';

const [receiptPath, kind, outPath] = process.argv.slice(2);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.state !== 'complete') throw new Error(`resolveBinding not complete: ${receipt.state}`);
const target = receipt.results[0];
if (!target) throw new Error('resolveBinding returned no anchor');
writeFileSync(outPath, `${JSON.stringify({ kind, target }, null, '\t')}\n`);
