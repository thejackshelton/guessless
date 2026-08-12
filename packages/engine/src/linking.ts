import { builtinModules } from 'node:module';
import type { Analyzer, Module } from 'yuku-analyzer';
import { anchorSite } from './anchors.ts';
import type { UnresolvedReason, UnresolvedSite } from './contracts.ts';

/**
 * Link honesty for supplied inputs.
 *
 * Yuku resolves relative specifiers against the supplied file set; every other
 * specifier is left unresolved. A build-tool alias ('containers/App/actions'
 * under webpack `resolve.modules`) is therefore indistinguishable from a real
 * package import by shape alone, and the importing file silently fails to join
 * the module graph: traversal queries neither answer from it nor name it.
 *
 * The only evidence available to the engine — without a second resolver, a
 * config reader, or the filesystem — is the supplied path set itself. So a
 * failed specifier that *names a supplied input* (matches some supplied path,
 * modulo extension, `/index`, and leading directories) is treated as a link
 * that should have been made and was not: reason 'unlinked-input'. A failed
 * specifier that names nothing in the supplied set is a recognized external or
 * builtin boundary and keeps its existing reason.
 *
 * The rule errs toward naming: a package specifier that happens to collide
 * with a supplied path is reported rather than assumed external.
 *
 * D6 — workspace package-name specifiers. The path-suffix test above is blind
 * to the shape a monorepo actually imports itself with: '@markless/serializer'
 * is not a path suffix of 'packages/serializer/src/index.ts', so before this
 * pass it was classified 'external-module-boundary' and dropped by
 * `unlinkedInputSites` — a supplied file whose *only* route to the corpus was a
 * workspace package specifier fell outside the dependents closure and outside
 * the naming pass at once, and vanished from the receipt without a trace.
 *
 * The second evidence available from the supplied set alone is its directory
 * shape: '@scope/name' (or bare 'name') whose package-name tail equals the last
 * segment of some supplied directory *may* denote files that were supplied.
 * That is strictly weaker evidence than a path match — no manifest, 'exports'
 * map, workspace glob or 'main' field is in the supplied set, so which supplied
 * file (if any) is the package's entry point is not knowable here — so it earns
 * its own reason, 'unlinked-workspace-package', and never a link. The engine
 * over-names rather than guessing an edge: a wrong link manufactures results,
 * which is worse than the silence it would replace.
 *
 * Precision bounds, stated honestly:
 *   - Sound direction: every supplied file stranded behind such a specifier is
 *     named. No supplied input reaching the corpus this way is silent.
 *   - Imprecise direction: a genuinely external package whose name happens to
 *     equal a supplied directory's last segment is named too (a false alarm,
 *     never a false result). The detail lists every matching directory, so the
 *     reader sees exactly what the match was made against, including when it is
 *     ambiguous across several roots.
 *   - A package whose name matches no supplied directory keeps
 *     'external-module-boundary': recognised boundaries gain no noise.
 */

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const moduleExtensions = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.cts', '.cjs'] as const;

function stripExtension(path: string): string {
	const extension = moduleExtensions.find((candidate) => path.endsWith(candidate));
	return extension === undefined ? path : path.slice(0, -extension.length);
}

function pathForms(path: string): string[] {
	const forms = new Set<string>([path]);
	const base = stripExtension(path);
	forms.add(base);
	if (base.endsWith('/index')) forms.add(base.slice(0, -'/index'.length));
	return [...forms].filter((form) => form.length > 0);
}

function segmentSuffixes(path: string): string[] {
	const parts = path.split('/');
	return parts
		.map((_, index) => parts.slice(index).join('/'))
		.filter((suffix) => suffix.length > 0);
}

/**
 * Everything the supplied path set can say about a failed specifier. Two
 * indexes, deliberately kept apart because they carry different strengths of
 * evidence:
 *
 * - `keys`: every name under which a supplied *file* could plausibly be
 *   requested — each supplied path, without its extension, without a trailing
 *   '/index', and with any number of leading directory segments dropped (alias
 *   roots are unknown). A hit here names a supplied file.
 * - `roots`: last directory segment -> every supplied directory ending in that
 *   segment, sorted. A hit here names supplied *directories*, which a package
 *   specifier may or may not denote; it never names a file.
 */
export interface LinkEvidence {
	readonly keys: ReadonlySet<string>;
	readonly roots: ReadonlyMap<string, readonly string[]>;
}

const indexCache = new WeakMap<Analyzer, { key: string; evidence: LinkEvidence }>();

export function linkEvidence(analyzer: Analyzer): LinkEvidence {
	const key = [...analyzer.modules.keys()].sort().join('\u0000');
	const cached = indexCache.get(analyzer);
	if (cached !== undefined && cached.key === key) return cached.evidence;
	const keys = new Set<string>();
	const directories = new Map<string, Set<string>>();
	for (const path of analyzer.modules.keys()) {
		for (const form of pathForms(path))
			for (const suffix of segmentSuffixes(form)) keys.add(suffix);
		const parts = path.split('/');
		for (let end = 1; end < parts.length; end += 1) {
			const segment = parts[end - 1];
			if (segment === undefined || segment.length === 0) continue;
			const directory = parts.slice(0, end).join('/');
			const bucket = directories.get(segment);
			if (bucket === undefined) directories.set(segment, new Set([directory]));
			else bucket.add(directory);
		}
	}
	const roots = new Map<string, readonly string[]>();
	for (const [segment, bucket] of directories) roots.set(segment, [...bucket].sort());
	const evidence: LinkEvidence = { keys, roots };
	indexCache.set(analyzer, { key, evidence });
	return evidence;
}

function normalizeSpecifier(specifier: string): string {
	const withoutLoaders = specifier.slice(specifier.lastIndexOf('!') + 1);
	const withoutQuery = withoutLoaders.split('?')[0]?.split('#')[0] ?? '';
	return withoutQuery.replace(/\/+$/, '').replace(/^\/+/, '');
}

/**
 * True when an unresolved specifier could name a file that was supplied to the
 * engine. Relative specifiers are excluded: yuku resolves those against the
 * supplied set directly (exact, then extensions, then '/index'), so a relative
 * miss proves the target was never supplied.
 */
export function namesSuppliedInput(specifier: string, keys: ReadonlySet<string>): boolean {
	if (specifier.startsWith('.')) return false;
	const normalized = normalizeSpecifier(specifier);
	if (normalized.length === 0) return false;
	return pathForms(normalized).some((form) => keys.has(form));
}

/**
 * The package name a specifier requests, and nothing more. '@scope/name' takes
 * two segments, a bare specifier one; any deeper subpath is discarded because
 * mapping a subpath onto a supplied file would require the package's 'exports'
 * map, which is not in the supplied set. Relative ('./x'), absolute ('/x') and
 * subpath-import ('#x') specifiers are not package specifiers and return null.
 */
export function packageNameOf(specifier: string): string | null {
	if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#'))
		return null;
	const parts = normalizeSpecifier(specifier)
		.split('/')
		.filter((part) => part.length > 0);
	const head = parts[0];
	if (head === undefined || head === '.' || head === '..') return null;
	if (!head.startsWith('@')) return head;
	const scoped = parts[1];
	return scoped === undefined ? null : `${head}/${scoped}`;
}

/**
 * The supplied directories a package specifier's *name tail* could denote:
 * '@markless/serializer' and 'serializer' both look for supplied directories
 * whose last segment is 'serializer'. Empty when nothing in the supplied set
 * carries that name — the specifier is then a recognized external boundary.
 */
export function suppliedRootsFor(
	specifier: string,
	roots: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
	const name = packageNameOf(specifier);
	if (name === null) return [];
	const tail = name.slice(name.lastIndexOf('/') + 1);
	if (tail.length === 0) return [];
	return roots.get(tail) ?? [];
}

export function boundaryReason(specifier: string, evidence: LinkEvidence): UnresolvedReason {
	if (nodeBuiltins.has(specifier)) return 'builtin-module-boundary';
	if (namesSuppliedInput(specifier, evidence.keys)) return 'unlinked-input';
	if (specifier.startsWith('.')) return 'unresolved-specifier';
	return suppliedRootsFor(specifier, evidence.roots).length > 0
		? 'unlinked-workspace-package'
		: 'external-module-boundary';
}

/** Roots are quoted in receipts; cap the list so one detail cannot run away. */
const MAX_QUOTED_ROOTS = 4;

function quoteRoots(roots: readonly string[]): string {
	const shown = roots.slice(0, MAX_QUOTED_ROOTS).map((root) => `'${root}'`);
	const rest = roots.length - shown.length;
	return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

export function boundaryDetail(
	kind: 'import' | 'export',
	specifier: string,
	reason: UnresolvedReason,
	evidence?: LinkEvidence,
): string {
	const subject = kind === 'import' ? `Import '${specifier}'` : `Export from '${specifier}'`;
	if (reason === 'unlinked-input')
		return `${subject} did not resolve, but names a supplied input; the link between these files could not be established.`;
	if (reason === 'unlinked-workspace-package') {
		const roots = evidence === undefined ? [] : suppliedRootsFor(specifier, evidence.roots);
		const where =
			roots.length === 0
				? 'a supplied directory'
				: roots.length === 1
					? `the supplied directory ${quoteRoots(roots)}`
					: `${roots.length} supplied directories (${quoteRoots(roots)}), so which one it denotes is ambiguous`;
		return `${subject} did not resolve; its package name matches ${where}, so it may name supplied inputs — but no supplied manifest proves which supplied file is that package's entry point, so the link was named rather than guessed.`;
	}
	return `${subject} leaves the linked file set.`;
}

/**
 * The two reasons that mean "a supplied input failed to join the graph". Both
 * are emitted by {@link unlinkedInputSites}; they differ only in the strength
 * of the evidence, which their details spell out.
 */
const strandedReasons: ReadonlySet<UnresolvedReason> = new Set<UnresolvedReason>([
	'unlinked-input',
	'unlinked-workspace-package',
]);

/**
 * Names every supplied input outside the traversed graph whose own specifiers
 * failed to link to another supplied input — whether the specifier named a
 * supplied *file* ('unlinked-input') or a supplied workspace *package root*
 * ('unlinked-workspace-package', D6). Such a file might belong in the traversal
 * and cannot be shown not to, so it is reported rather than dropped. Modules
 * already inside the traversed set are skipped: their boundaries are named by
 * the traversal's own gap collection, with identical anchors.
 */
export function unlinkedInputSites(
	analyzer: Analyzer,
	traversed: ReadonlySet<Module>,
	labelPrefix = '',
): UnresolvedSite[] {
	const evidence = linkEvidence(analyzer);
	const sites: UnresolvedSite[] = [];
	for (const module of analyzer.modules.values()) {
		if (traversed.has(module)) continue;
		for (const record of module.imports) {
			if (record.resolvedModule !== null) continue;
			const reason = boundaryReason(record.specifier, evidence);
			if (!strandedReasons.has(reason)) continue;
			sites.push({
				site: anchorSite(module, record.node, `${labelPrefix}import-boundary`),
				reason,
				detail: boundaryDetail('import', record.specifier, reason, evidence),
			});
		}
		for (const record of module.exports) {
			if (record.specifier === null || record.resolvedModule !== null) continue;
			const reason = boundaryReason(record.specifier, evidence);
			if (!strandedReasons.has(reason)) continue;
			sites.push({
				site: anchorSite(module, record.node, `${labelPrefix}export-boundary`),
				reason,
				detail: boundaryDetail('export', record.specifier, reason, evidence),
			});
		}
	}
	return sites;
}
