// build-ground-truth.mjs — bounded hand-audit, mechanically enumerated.
//
// The *enumeration* is mechanical: every `\b<sym>\b` occurrence (file, line, column) in the
// committed 635-file input set. The *classification* is the hand audit below: for each file that
// contains a hit, I read the file's imports and declarations and recorded which binding the name
// is bound to in that file, with the evidence line. The script refuses to run if a file with hits
// is missing from the audit map, so the audit cannot silently drift from the corpus.
//
// Both audited symbols have at most one binding of the name in scope per file (verified: the only
// files that *declare* the name are packages/serializer/src/value-decode.ts and
// packages/web/src/payload-graph-construct.ts for S1, packages/serializer/src/async-boundary-arm.ts
// for S2), so a file-level classification is exact at occurrence level.
//
// Also records the verbatim baseline: the rg command and its full hit list.
//
// Usage: node docs/evidence/adoption-eval-fable-v2/demonstration/build-ground-truth.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKLESS = '/Users/jacksm5pro/dev/open-source/markless';
const COMMIT = '931f054444a41c0527dfa77f812fa49e87df3b8f';

const inputPaths = readFileSync(join(HERE, 'input-files.txt'), 'utf8').trim().split('\n');

const scratch = mkdtempSync(join(tmpdir(), 'guessless-gt-'));
const corpus = join(scratch, 'corpus');
mkdirSync(corpus);
const tarPath = join(scratch, 'corpus.tar');
execFileSync('git', ['-C', MARKLESS, 'archive', COMMIT, '-o', tarPath, '--', ...inputPaths]);
execFileSync('tar', ['-x', '-f', tarPath, '-C', corpus]);

// --- hand audit -------------------------------------------------------------------------------
// binding: which declaration the name is bound to in this file.
// route:   how the file reaches that declaration (the chain I followed by hand).
const AUDIT = {
	deserializeGraphValue: {
		declaration: { file: 'packages/serializer/src/value-decode.ts', line: 5 },
		decoyDeclaration: { file: 'packages/web/src/payload-graph-construct.ts', line: 148 },
		files: {
			'packages/serializer/src/value-decode.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: 'declaring module',
				evidence: "value-decode.ts:5 'export function deserializeGraphValue(payload: SerializedGraphPayload): unknown {'",
				declarationLines: [5],
			},
			'packages/serializer/src/value.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "re-export specifier -> './value-decode.ts'",
				evidence: "value.ts:120 \"export { deserializeGraphValue } from './value-decode.ts';\"",
			},
			'packages/compiler/src/passes/public-render/shared.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'@markless/serializer' -> packages/serializer/package.json exports '.' -> src/index.ts -> 'export * from ./value.ts' -> 'export { deserializeGraphValue } from ./value-decode.ts'",
				evidence: "shared.ts:2 \"import { deserializeGraphValue, type SerializedGraphPayload } from '@markless/serializer';\"",
			},
			'packages/compiler/src/passes/public-render/state-entries.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'@markless/serializer' -> src/index.ts -> value.ts -> value-decode.ts",
				evidence: "state-entries.ts:1 \"import { deserializeGraphValue } from '@markless/serializer';\"",
			},
			'packages/compiler/test/compile-module.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../../serializer/src/index.ts' -> value.ts -> value-decode.ts",
				evidence: "compile-module.test.ts:3-7 \"import { ASYNC_BOUNDARY_ARM, deserializeGraphValue, renderPayloadScripts } from '../../serializer/src/index.ts';\"",
			},
			'packages/serializer/test/module-split.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../src/value-decode.ts' (direct)",
				evidence: "module-split.test.ts:16 \"import { deserializeGraphValue } from '../src/value-decode.ts';\"",
			},
			'packages/serializer/test/payload-scripts.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../src/index.ts' -> value.ts -> value-decode.ts",
				evidence: "payload-scripts.test.ts:2-6 \"import { …, deserializeGraphValue } from '../src/index.ts';\"",
			},
			'packages/serializer/test/protocol-state.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../src/index.ts' -> value.ts -> value-decode.ts",
				evidence: "protocol-state.test.ts:2-7 \"import { …, deserializeGraphValue, … } from '../src/index.ts';\"",
			},
			'packages/serializer/test/serializer.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../src/index.ts' -> value.ts -> value-decode.ts",
				evidence: "serializer.test.ts:2 \"import { deserializeGraphValue, serializeGraphValue } from '../src/index.ts';\"",
			},
			'packages/serializer/test/value-correctness.test.ts': {
				class: 'target',
				binding: 'value-decode.ts#deserializeGraphValue',
				route: "'../src/index.ts' -> value.ts -> value-decode.ts",
				evidence: "value-correctness.test.ts:2 \"import { deserializeGraphValue, serializeGraphValue } from '../src/index.ts';\"",
			},
			'packages/web/src/payload-graph-construct.ts': {
				class: 'decoy',
				binding: 'payload-graph-construct.ts#deserializeGraphValue (module-local async function)',
				route: 'declared in this module; never imported from the serializer',
				evidence: "payload-graph-construct.ts:148 'async function deserializeGraphValue(payload: SerializedGraphPayload): Promise<unknown> {' — the file imports no deserializeGraphValue; it lazily imports deserializeGraphValueForClient from '../../serializer/src/value-decode-client.ts'",
				declarationLines: [148],
			},
		},
	},
	ASYNC_BOUNDARY_ARM: {
		declaration: { file: 'packages/serializer/src/async-boundary-arm.ts', line: 7 },
		decoyDeclaration: null,
		files: {},
	},
};

// S2: every hit file binds the one declaration; the audited route per file is its import
// specifier, recorded here from the file's own import statement.
const S2_ROUTES = {
	'packages/serializer/src/async-boundary-arm.ts': ['declaring module', [7]],
	'packages/serializer/src/protocol.ts': ["'./async-boundary-arm.ts' (direct)", []],
	'packages/serializer/src/protocol-validation.ts': ["'./protocol.ts' -> re-export -> async-boundary-arm.ts", []],
	'packages/serializer/test/module-split.test.ts': ["'../src/index.ts' -> protocol.ts -> async-boundary-arm.ts", []],
	'packages/serializer/test/protocol.test.ts': ["'../src/index.ts' -> protocol.ts -> async-boundary-arm.ts", []],
	'packages/compiler/test/compile-module.test.ts': ["'../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/router/boxes/router-streaming-settle.box.ts': ["'../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/router/test/vite/runtime/create-server-entry.test.ts': ["'../../../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/vitest-browser/browser/stream-arm-executor.test.ts': ["'../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/web/test/debug-channel-registration.test.ts': ["'../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/web/test/payload-scripts.test.ts': ["'../../serializer/src/index.ts' -> protocol.ts", []],
	'packages/compiler/src/passes/render-data/index.ts': ["'@markless/serializer/protocol' -> exports './protocol' -> src/protocol.ts -> async-boundary-arm.ts", []],
	'packages/compiler/test/render-data/render-data.test.ts': ["'@markless/serializer/protocol' -> src/protocol.ts", []],
	'packages/web/src/resume-async-wiring.ts': ["'@markless/serializer/async-boundary-arm' -> src/async-boundary-arm.ts (direct)", []],
	'packages/compiler/test/boundary-runner-agreement.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/compiler/test/payload-arena.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/compiler/test/protocol-view.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/src/fns/ssr.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/src/prerender/adopt-filled-arms.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/src/render-to-stream.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/src/ssr-data/renderer.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/commit-arm.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/render-to-stream.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/render.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/resettle-hold-timing.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/resume-stream-patches.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/resume.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/settle-tracker-timing.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/ssr-boundary-fields.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
	'packages/web/test/ssr-data/renderer.test.ts': ["'@markless/serializer' -> src/index.ts -> protocol.ts", []],
};
for (const [file, [route, declarationLines]] of Object.entries(S2_ROUTES)) {
	AUDIT.ASYNC_BOUNDARY_ARM.files[file] = {
		class: 'target',
		binding: 'async-boundary-arm.ts#ASYNC_BOUNDARY_ARM',
		route,
		evidence: `import chain recorded by hand from ${file}`,
		declarationLines,
	};
}

// --- enumeration ------------------------------------------------------------------------------
const symbols = [
	{ id: 'S1', name: 'deserializeGraphValue' },
	{ id: 'S2', name: 'ASYNC_BOUNDARY_ARM' },
];

for (const symbol of symbols) {
	const audit = AUDIT[symbol.name];
	// This machine has no ripgrep binary on PATH ('rg' is a shell function), so the baseline is
	// taken with `grep -rnw`, which is exactly ripgrep's `\b<sym>\b` word-boundary match. The two
	// were compared on this corpus for both symbols: after sorting, the hit lists are byte-identical
	// (37 lines for S1, 112 for S2). Whichever tool is present is recorded below.
	let rgOut;
	let baselineCommand = `rg -n '\\b${symbol.name}\\b' --sort path packages`;
	let baselineTool = 'ripgrep';
	try {
		rgOut = execFileSync('rg', ['-n', `\\b${symbol.name}\\b`, '--sort', 'path', 'packages'], {
			cwd: corpus,
			encoding: 'utf8',
			maxBuffer: 1 << 28,
		});
	} catch (error) {
		if (error.code === 'ENOENT') {
			baselineTool = 'grep -rnw (word-boundary equivalent of the rg pattern)';
			baselineCommand = `grep -rnw '${symbol.name}' packages | LC_ALL=C sort`;
			try {
				rgOut = execFileSync('sh', ['-c', `grep -rnw '${symbol.name}' packages | LC_ALL=C sort`], {
					cwd: corpus,
					encoding: 'utf8',
					maxBuffer: 1 << 28,
				});
			} catch (inner) {
				rgOut = inner.stdout ?? '';
			}
		} else {
			rgOut = error.stdout ?? '';
		}
	}
	writeFileSync(join(HERE, `baseline-${symbol.id}.txt`), rgOut);
	const rgLines = rgOut.trim().split('\n');

	const pattern = new RegExp(`\\b${symbol.name}\\b`, 'g');
	const sites = [];
	for (const path of inputPaths) {
		const source = readFileSync(join(corpus, path), 'utf8');
		if (!source.includes(symbol.name)) continue;
		const lines = source.split('\n');
		let seen = false;
		for (const [index, text] of lines.entries()) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(text)) !== null) {
				seen = true;
				const entry = audit.files[path];
				if (entry === undefined) {
					throw new Error(`unaudited file with ${symbol.name} hits: ${path}`);
				}
				const line = index + 1;
				const isDeclaration = (entry.declarationLines ?? []).includes(line);
				sites.push({
					file: path,
					line,
					column: match.index + 1,
					class: isDeclaration ? `${entry.class}-declaration` : entry.class,
					binding: entry.binding,
					route: entry.route,
					text: text.trim().slice(0, 160),
				});
			}
		}
		if (!seen && audit.files[path] !== undefined) {
			throw new Error(`audited file has no \\b${symbol.name}\\b occurrence: ${path}`);
		}
	}

	const targetSites = sites.filter((s) => s.class === 'target');
	const decoySites = sites.filter((s) => s.class === 'decoy' || s.class === 'decoy-declaration');
	const byFile = {};
	for (const site of targetSites) byFile[site.file] = (byFile[site.file] ?? 0) + 1;

	const ground = {
		schema: 'guessless.demonstration.ground-truth/v1',
		symbol: symbol.name,
		symbolId: symbol.id,
		corpus: {
			repo: MARKLESS,
			commit: COMMIT,
			inputFiles: inputPaths.length,
			inputList: 'input-files.txt',
		},
		declaration: audit.declaration,
		decoyDeclaration: audit.decoyDeclaration,
		method:
			'Occurrences enumerated mechanically over the committed input set; each hit file classified by hand from its imports/declarations (route recorded per site). Declaration occurrences are marked *-declaration and are not reference sites.',
		baseline: {
			command: baselineCommand,
			tool: baselineTool,
			cwd: 'a read-only extract of the input set at the audited commit',
			hitLines: rgLines.length,
			hitList: `baseline-${symbol.id}.txt`,
		},
		counts: {
			occurrences: sites.length,
			targetReferenceSites: targetSites.length,
			targetDeclarationSites: sites.filter((s) => s.class === 'target-declaration').length,
			decoySites: decoySites.length,
			baselineTrueHits: sites.filter((s) => s.class.startsWith('target')).length,
			baselineDecoyHits: decoySites.length,
		},
		targetSitesByFile: byFile,
		sites,
	};
	writeFileSync(join(HERE, `ground-truth-${symbol.id}.json`), `${JSON.stringify(ground, null, 1)}\n`);
	console.log(
		`${symbol.id} ${symbol.name}: ${sites.length} occurrences, ${targetSites.length} target reference sites, ${decoySites.length} decoy sites, ${rgLines.length} rg hit lines`,
	);
}

rmSync(scratch, { recursive: true, force: true });
