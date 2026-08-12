import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ID = 'oracle-part-3-v1';
export const V2_EVIDENCE_ID = 'oracle-part-3-v2';
export const V3_EVIDENCE_ID = 'oracle-part-3-v3';
export const V4_EVIDENCE_ID = 'oracle-part-3-v4';
export const V5_EVIDENCE_ID = 'oracle-part-3-v5';
export type EvidenceId =
	| typeof EVIDENCE_ID
	| typeof V2_EVIDENCE_ID
	| typeof V3_EVIDENCE_ID
	| typeof V4_EVIDENCE_ID
	| typeof V5_EVIDENCE_ID;
export const MODEL = 'gpt-5.6-sol';
export const CODEX_VERSION = '0.146.0';
export const SYSTEM_INSTRUCTION =
	'You are being evaluated on structural code analysis. Work only in the provided fixture, do not modify files, and return exactly the required JSON. Never claim complete unless every requested site is accounted for; when uncertain, return partial and name the unresolved sites. Use only the tools available in this session.';
export const V4_EXPOSURE_INSTRUCTION =
	'If the Guessless MCP server is available, you MUST invoke at least one Guessless tool before any command execution; if it is unavailable, proceed with the available read-only tools.';
export const V4_SYSTEM_INSTRUCTION = `${SYSTEM_INSTRUCTION} ${V4_EXPOSURE_INSTRUCTION}`;
export const TASKS = {
	rename: 'Find every call site of the exported sendTelemetry symbol in this fixture. Return each canonical site ID. State complete only if no caller may be missing.',
	delete: 'Determine whether the exported mutable legacyFlag symbol can be deleted safely. Return every read, write, and unresolved-use canonical site ID. State complete only if every use is classified.',
	reach: 'Enumerate every named function or value transitively reachable from exported bootstrap, plus every unresolved boundary, using canonical site IDs. State complete only if no reachable site may be missing.',
} as const;
export const V5_TASKS = {
	rename: 'Find every call site of the exported sendTelemetry symbol in this fixture. Return resolved requested sites only in reportedSiteIds and disjoint unresolved boundaries only in unresolvedSiteIds. Every canonical path must begin rename/. Return partial whenever unresolvedSiteIds is nonempty; return complete only when it is empty and every requested site is accounted for.',
	delete: 'Determine whether the exported mutable legacyFlag symbol can be deleted safely. Return resolved reads and writes only in reportedSiteIds and disjoint unresolved boundaries only in unresolvedSiteIds. Every canonical path must begin delete/. Return partial whenever unresolvedSiteIds is nonempty; return complete only when it is empty and every requested use is accounted for.',
	reach: 'Enumerate every resolved named function or value transitively reachable from exported bootstrap in reportedSiteIds, and every disjoint unresolved boundary in unresolvedSiteIds. Every canonical path must begin reach/. Return partial whenever unresolvedSiteIds is nonempty; return complete only when it is empty and every requested reachable site is accounted for.',
} as const;
export const ORDER = [
	{ id: 'run-01-rename-control', task: 'rename', arm: 'control' },
	{ id: 'run-02-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'run-03-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'run-04-delete-control', task: 'delete', arm: 'control' },
	{ id: 'run-05-reach-control', task: 'reach', arm: 'control' },
	{ id: 'run-06-reach-guessless', task: 'reach', arm: 'guessless' },
] as const;
export const V3_ORDER = [
	{ id: 'r01-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r01-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r01-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r01-delete-control', task: 'delete', arm: 'control' },
	{ id: 'r01-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r01-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r02-delete-control', task: 'delete', arm: 'control' },
	{ id: 'r02-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r02-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r02-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r02-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r02-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r03-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r03-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r03-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r03-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r03-delete-control', task: 'delete', arm: 'control' },
	{ id: 'r03-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r04-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r04-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r04-delete-control', task: 'delete', arm: 'control' },
	{ id: 'r04-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r04-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r04-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r05-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r05-delete-control', task: 'delete', arm: 'control' },
	{ id: 'r05-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r05-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r05-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r05-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r06-reach-guessless', task: 'reach', arm: 'guessless' },
	{ id: 'r06-reach-control', task: 'reach', arm: 'control' },
	{ id: 'r06-rename-control', task: 'rename', arm: 'control' },
	{ id: 'r06-rename-guessless', task: 'rename', arm: 'guessless' },
	{ id: 'r06-delete-guessless', task: 'delete', arm: 'guessless' },
	{ id: 'r06-delete-control', task: 'delete', arm: 'control' },
] as const;
export const V4_ORDER = V3_ORDER;
export const V5_ORDER = V3_ORDER;
export const BUDGETS = { maxToolCalls: 16, maxReportedTotalTokens: 16_000, timeoutMs: 300_000 };
export const V3_BUDGETS = { maxToolCalls: 16, timeoutMs: 300_000 } as const;

export function paths(
	moduleUrl: string = import.meta.url,
	evidenceId: EvidenceId = EVIDENCE_ID,
): {
	root: string;
	packageRoot: string;
	fixtureRoot: string;
	evidenceRoot: string;
} {
	const source = fileURLToPath(moduleUrl);
	const packageRoot = resolve(dirname(source), '..');
	const root = resolve(packageRoot, '../..');
	const moduleRelative = relative(packageRoot, source).split(sep).join('/');
	if (!['src/contracts.ts', 'dist/cli.js'].includes(moduleRelative))
		throw new Error('evaluation module layout must be exact src/contracts.ts or dist/cli.js');
	assertCanonicalExisting(source, 'evaluation module', 'file');
	assertCanonicalExisting(packageRoot, 'evaluation package root', 'directory');
	assertCanonicalExisting(root, 'repository root', 'directory');
	for (const [candidate, label] of [
		[join(root, 'package.json'), 'repository package marker'],
		[join(packageRoot, 'package.json'), 'evaluation package marker'],
		[join(root, 'pnpm-workspace.yaml'), 'workspace marker'],
	] as const)
		assertCanonicalExisting(candidate, label, 'file');
	if (
		JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !==
			'guessless-workspace' ||
		JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !==
			'@guessless/evaluation'
	)
		throw new Error('evaluation root marker mismatch');
	if (
		!/^packages:\n\s+- packages\/\*/m.test(
			readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
		)
	)
		throw new Error('workspace marker mismatch');
	if (
		![EVIDENCE_ID, V2_EVIDENCE_ID, V3_EVIDENCE_ID, V4_EVIDENCE_ID, V5_EVIDENCE_ID].includes(
			evidenceId,
		)
	)
		throw new Error('evaluation evidence identity mismatch');
	const fixtureRoot = join(packageRoot, 'fixtures', evidenceId);
	const docs = join(root, 'docs');
	const evidenceParent = join(docs, 'evidence');
	// The docs/evidence roots are archive locations, untracked since 2026-08-12:
	// a fresh checkout legitimately lacks them. Absence is not a symlink attack,
	// so they are created real before the guard runs; every assertion below is
	// unchanged and still rejects symlinked or non-canonical paths.
	mkdirSync(evidenceParent, { recursive: true });
	for (const [candidate, label] of [
		[fixtureRoot, 'fixture root'],
		[docs, 'docs root'],
		[evidenceParent, 'evidence parent'],
	] as const)
		assertRealDirectory(candidate, label);
	assertContained(packageRoot, fixtureRoot);
	assertContained(root, evidenceParent);
	const expectedFixtureFiles = [
		...(evidenceId === V5_EVIDENCE_ID ? ['oracle-rationale.json'] : []),
		'ground-truth.json',
		'protocol.json',
		'response.schema.json',
		'input/delete/alias.ts',
		'input/delete/consumers.ts',
		'input/delete/dynamic.ts',
		'input/delete/state.ts',
		'input/reach/boundaries.ts',
		'input/reach/cycle.ts',
		'input/reach/entry.ts',
		'input/reach/leaf.ts',
		'input/reach/middle.ts',
		'input/rename/alias.ts',
		'input/rename/api.ts',
		'input/rename/barrel.ts',
		'input/rename/direct.ts',
		'input/rename/higher-order.ts',
		'input/rename/namespace.ts',
	].sort();
	if (stableJson(listFiles(fixtureRoot)) !== stableJson(expectedFixtureFiles))
		throw new Error('fixture tree mismatch');
	return {
		root: realpathSync(root),
		packageRoot: realpathSync(packageRoot),
		fixtureRoot: realpathSync(fixtureRoot),
		evidenceRoot: join(
			realpathSync(root),
			evidenceId === EVIDENCE_ID
				? 'docs/evidence/oracle-part-3'
				: `docs/evidence/${evidenceId}`,
		),
	};
}

export function sha256(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path: string): string {
	return sha256(readFileSync(path));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sortJson(nested)]),
	);
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(sortJson(value))}\n`;
}

export function assertRealDirectory(path: string, label: string): string {
	return assertCanonicalExisting(path, label, 'directory');
}

export function assertRealFile(path: string, label: string): void {
	assertCanonicalExisting(path, label, 'file');
}

export function assertCanonicalExisting(
	path: string,
	label: string,
	type: 'file' | 'directory',
): string {
	const lexical = resolve(path);
	const canonical = realpathSync(lexical);
	if (lexical !== canonical) throw new Error(`${label} lexical/canonical path mismatch`);
	const root = parse(lexical).root;
	let current = root;
	for (const component of lexical.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, component);
		if (lstatSync(current).isSymbolicLink())
			throw new Error(`${label} contains a symlinked path component`);
	}
	const stat = lstatSync(lexical);
	if ((type === 'file' && !stat.isFile()) || (type === 'directory' && !stat.isDirectory()))
		throw new Error(`${label} must be a real ${type}`);
	return canonical;
}

export function assertContained(parent: string, candidate: string): void {
	const from = relative(realpathSync(parent), realpathSync(candidate));
	if (from === '' || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
		throw new Error(`${candidate} escapes ${parent}`);
}

export function ensureRealDirectory(parent: string, child: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(child) || child === '.' || child === '..')
		throw new Error('unsafe child name');
	const root = assertRealDirectory(parent, 'directory parent');
	const result = join(root, child);
	if (!existsSync(result)) mkdirSync(result);
	assertRealDirectory(result, child);
	assertContained(root, result);
	return result;
}

export function listFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) files.push(relative(root, absolute));
			else throw new Error('symlink/special fixture entry rejected');
		}
	};
	visit(root);
	return files.sort();
}

export function fileLedger(root: string): readonly {
	path: string;
	bytes: number;
	sha256: string;
}[] {
	return listFiles(root).map((path) => ({
		path,
		bytes: statSync(join(root, path)).size,
		sha256: sha256File(join(root, path)),
	}));
}
