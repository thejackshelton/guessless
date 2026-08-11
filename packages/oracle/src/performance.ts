import { spawnSync } from 'node:child_process';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import type { GuesslessEngine as GuesslessEngineType, Receipt } from '../../engine/src/index.ts';
import {
	GENERATOR_SEED,
	GENERATOR_VERSION,
	PERFORMANCE_LINES,
	sha256Bytes,
	stableJson,
} from './contracts.ts';

const enginePackage: string = '@guessless/engine';
const { GuesslessEngine } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

export const QUERY_KINDS = [
	'definitionOf',
	'referencesOf',
	'readsOf',
	'writesOf',
	'exportedNames',
	'capturesOf',
	'resolveBinding',
	'reachableFrom',
	'reaches',
] as const;

interface TimingSummary {
	readonly rawNs: readonly string[];
	readonly p50Ns: string;
	readonly p95Ns: string;
}

export interface PerformanceRecord {
	readonly schema: 'guessless.performance/v1';
	readonly generator: { readonly version: string; readonly seed: number };
	readonly lines: number;
	readonly files: 1;
	readonly bytes: number;
	readonly sourceSha256: string;
	readonly physicalLinesVerified: boolean;
	readonly coldTrials: readonly {
		readonly addFileNs: string;
		readonly linkNs: string;
		readonly totalNs: string;
		readonly addFileState: 'accepted';
	}[];
	readonly queries: Readonly<
		Record<
			(typeof QUERY_KINDS)[number],
			TimingSummary & { readonly receiptStates: readonly string[] }
		>
	>;
	readonly process: {
		readonly argv: readonly string[];
		readonly node: string;
		readonly pnpm: string;
		readonly maxOldSpaceMiB: number;
		readonly timeoutMs: number;
		readonly platform: string;
		readonly release: string;
		readonly hostname: string;
		readonly cpu: string;
		readonly cpuCount: number;
		readonly totalMemoryBytes: number;
		readonly freeMemoryBytes: number;
	};
}

export interface PerformanceProcessEvidence {
	readonly lines: number;
	readonly command: readonly string[];
	readonly timeoutMs: number;
	readonly maxOldSpaceMiB: number;
	readonly status: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly record?: PerformanceRecord;
}

export function serializePerformanceRecord(record: PerformanceRecord): string {
	return stableJson(record);
}

export function generateSource(lines: number): string {
	if (!Number.isInteger(lines) || lines < 10)
		throw new Error('line count must be an integer >= 10');
	const fixed = [
		'export let root = 1;',
		'root;',
		'root = 2;',
		'export function leaf(): void {}',
		'export function entry(): void { leaf(); }',
		'export function closure() { return () => root; }',
		'export interface TypeOnly { value: number }',
		'export namespace Names { export const item = 1; }',
		'export const seed = 0x47554553;',
	];
	const generated = [...fixed];
	for (let line = fixed.length + 1; line <= lines; line += 1)
		generated.push(`// synthetic ${GENERATOR_SEED.toString(16)} line ${line}`);
	const source = `${generated.join('\n')}\n`;
	if (source.split('\n').length - 1 !== lines)
		throw new Error('generator line-count invariant failed');
	return source;
}

export function percentile(raw: readonly bigint[], fraction: number): bigint {
	const sorted = [...raw].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summary(raw: readonly bigint[]): TimingSummary {
	return {
		rawNs: raw.map(String),
		p50Ns: String(percentile(raw, 0.5)),
		p95Ns: String(percentile(raw, 0.95)),
	};
}

function load(source: string): {
	engine: GuesslessEngineType;
	addFileNs: bigint;
	linkNs: bigint;
	totalNs: bigint;
} {
	const engine = new GuesslessEngine();
	const totalStart = process.hrtime.bigint();
	const addStart = process.hrtime.bigint();
	const added = engine.addFile('synthetic.ts', source);
	const addEnd = process.hrtime.bigint();
	if ('schema' in added) throw new Error(`synthetic corpus returned a ${added.state} receipt`);
	const linkStart = process.hrtime.bigint();
	engine.link();
	const linkEnd = process.hrtime.bigint();
	return {
		engine,
		addFileNs: addEnd - addStart,
		linkNs: linkEnd - linkStart,
		totalNs: linkEnd - totalStart,
	};
}

function queries(
	engine: GuesslessEngineType,
): Record<(typeof QUERY_KINDS)[number], () => Receipt<unknown>> {
	const root = engine.anchor('synthetic.ts', 'root');
	const closure = engine.anchor('synthetic.ts', 'closure');
	const entry = engine.anchor('synthetic.ts', 'entry');
	if (root === null || closure === null || entry === null)
		throw new Error('synthetic target anchors are missing');
	return {
		definitionOf: () => engine.definitionOf(root),
		referencesOf: () => engine.referencesOf(root),
		readsOf: () => engine.readsOf(root),
		writesOf: () => engine.writesOf(root),
		exportedNames: () => engine.exportedNames('synthetic.ts'),
		capturesOf: () => engine.capturesOf(closure),
		resolveBinding: () => engine.resolveBinding('synthetic.ts', 'root', 'value'),
		reachableFrom: () => engine.reachableFrom(entry),
		reaches: () => engine.reaches(entry),
	};
}

export function runPerformanceWorker(lines: number): PerformanceRecord {
	if (!PERFORMANCE_LINES.includes(lines as (typeof PERFORMANCE_LINES)[number]))
		throw new Error(`unsupported performance line count ${lines}`);
	const source = generateSource(lines);
	const coldTrials: PerformanceRecord['coldTrials'][number][] = [];
	let current: GuesslessEngineType | undefined;
	for (let trial = 0; trial < 3; trial += 1) {
		const loaded = load(source);
		current = loaded.engine;
		coldTrials.push({
			addFileNs: String(loaded.addFileNs),
			linkNs: String(loaded.linkNs),
			totalNs: String(loaded.totalNs),
			addFileState: 'accepted',
		});
	}
	if (current === undefined) throw new Error('cold trials did not run');
	const functions = queries(current);
	const queryEvidence = {} as Record<
		(typeof QUERY_KINDS)[number],
		TimingSummary & { receiptStates: string[] }
	>;
	for (const kind of QUERY_KINDS) {
		functions[kind]();
		const raw: bigint[] = [];
		const receiptStates: string[] = [];
		for (let iteration = 0; iteration < 30; iteration += 1) {
			const start = process.hrtime.bigint();
			const receipt = functions[kind]();
			raw.push(process.hrtime.bigint() - start);
			receiptStates.push(receipt.state);
		}
		queryEvidence[kind] = { ...summary(raw), receiptStates };
	}
	const cpu = cpus();
	return {
		schema: 'guessless.performance/v1',
		generator: { version: GENERATOR_VERSION, seed: GENERATOR_SEED },
		lines,
		files: 1,
		bytes: Buffer.byteLength(source),
		sourceSha256: sha256Bytes(source),
		physicalLinesVerified: source.split('\n').length - 1 === lines,
		coldTrials,
		queries: queryEvidence,
		process: {
			argv: process.argv,
			node: process.version,
			pnpm: process.env.npm_config_user_agent ?? 'unknown',
			maxOldSpaceMiB: Number(process.env.GUESSLESS_MAX_OLD_SPACE_MIB ?? 0),
			timeoutMs: Number(process.env.GUESSLESS_TIMEOUT_MS ?? 0),
			platform: platform(),
			release: release(),
			hostname: hostname(),
			cpu: cpu[0]?.model ?? 'unknown',
			cpuCount: cpu.length,
			totalMemoryBytes: totalmem(),
			freeMemoryBytes: freemem(),
		},
	};
}

export function recordPerformance(cliPath: string): PerformanceProcessEvidence[] {
	return PERFORMANCE_LINES.map((lines) => {
		const maxOldSpaceMiB = lines === 1_000_000 ? 8192 : 4096;
		const timeoutMs = lines === 1_000_000 ? 20 * 60_000 : 5 * 60_000;
		const command = [
			process.execPath,
			`--max-old-space-size=${maxOldSpaceMiB}`,
			cliPath,
			'performance-worker',
			String(lines),
		];
		const result = spawnSync(command[0], command.slice(1), {
			encoding: 'utf8',
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			env: {
				...process.env,
				GUESSLESS_ORACLE_NETWORK_CONSENT: 'disabled',
				GUESSLESS_MAX_OLD_SPACE_MIB: String(maxOldSpaceMiB),
				GUESSLESS_TIMEOUT_MS: String(timeoutMs),
			},
		});
		const stdout = result.stdout;
		let record: PerformanceRecord | undefined;
		if (result.status === 0) record = JSON.parse(stdout) as PerformanceRecord;
		return {
			lines,
			command,
			timeoutMs,
			maxOldSpaceMiB,
			status: result.status,
			signal: result.signal,
			stdout,
			stderr: result.stderr,
			...(record === undefined ? {} : { record }),
		};
	});
}
