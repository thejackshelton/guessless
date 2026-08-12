import { join } from 'node:path';
import { defineConfig } from 'vite-plus';

const rootDir = import.meta.dirname;

/**
 * Evidence-era integrity suites — opt-in, excluded from the default `pnpm test` gate.
 *
 * Each file below verifies one sealed oracle part 3 preregistration/measurement fixture: its frozen
 * tasks, order, model, budgets, scoring rules and neutral prompts, plus the manifest that pins the
 * sha256 of every artifact the evidence was sealed against — including the built
 * `packages/engine/dist/index.js` of that era, and the test file itself.
 *
 * Why they are opt-in rather than part of the default gate:
 *   - v7..v11 pin an engine bundle no fresh checkout rebuilds byte-for-byte, so on the default gate
 *     they fail for reasons that say nothing about the health of the current product.
 *   - v6 pins the *current* engine bundle, so leaving it in the gate lets a sealed record from a
 *     past evidence era veto all future engine development.
 * Gating changes only when these suites run. No assertion in them is weakened, skipped or removed,
 * and their bytes are deliberately untouched: each manifest pins the sha256 of its own test file, so
 * even adding a header comment inside one of these files would falsify the seal it exists to
 * witness. That is why this note lives here instead of at the top of each file.
 *
 * Run them (together with the opt-in oracle evidence tests) with:
 *   pnpm test:evidence
 * Or one suite at a time, e.g.:
 *   GUESSLESS_EVIDENCE_TESTS=1 pnpm exec vp test --project evidence v7-evaluation
 */
const evidenceSuites = [
	'packages/evaluation/test/v6-evaluation.test.ts',
	'packages/evaluation/test/v7-evaluation.test.ts',
	'packages/evaluation/test/v8-evaluation.test.ts',
	'packages/evaluation/test/v9-evaluation.test.ts',
	'packages/evaluation/test/v10-evaluation.test.ts',
	'packages/evaluation/test/v11-evaluation.test.ts',
];

// The `evidence` project only exists under the opt-in flag, so no invocation of `vp test` — with or
// without `--project` — can pull these suites into a default run by accident.
const evidenceOptIn = process.env.GUESSLESS_EVIDENCE_TESTS === '1';

export default defineConfig({
	pack: [
		{
			name: '@guessless/engine',
			cwd: join(rootDir, 'packages/engine'),
			entry: { index: './src/index.ts' },
			format: ['esm'],
			outDir: './dist',
			platform: 'node',
			fixedExtension: false,
			dts: false,
			clean: true,
			deps: { neverBundle: [/^node:/, /^yuku-analyzer(?:\/.*)?$/], onlyBundle: false },
		},
		{
			name: '@guessless/mcp',
			cwd: join(rootDir, 'packages/mcp'),
			entry: { index: './src/index.ts', server: './src/server.ts' },
			format: ['esm'],
			outDir: './dist',
			platform: 'node',
			fixedExtension: false,
			outputOptions: { chunkFileNames: 'src-DnFJEf5U.js' },
			dts: false,
			clean: true,
			deps: {
				neverBundle: [
					/^node:/,
					/^@guessless\/engine(?:\/.*)?$/,
					/^@modelcontextprotocol\/sdk(?:\/.*)?$/,
					/^pathe(?:\/.*)?$/,
					/^ufo(?:\/.*)?$/,
					/^zod(?:\/.*)?$/,
				],
				onlyBundle: false,
			},
		},
		{
			name: 'guessless',
			cwd: join(rootDir, 'packages/cli'),
			entry: { index: './src/index.ts', cli: './src/cli.ts' },
			format: ['esm'],
			outDir: './dist',
			platform: 'node',
			fixedExtension: false,
			dts: false,
			clean: true,
			deps: {
				neverBundle: [/^node:/, /^@guessless\/engine(?:\/.*)?$/],
				onlyBundle: false,
			},
		},
		{
			name: '@guessless/oracle',
			cwd: join(rootDir, 'packages/oracle'),
			entry: { cli: './src/cli.ts' },
			format: ['esm'],
			outDir: './dist',
			platform: 'node',
			fixedExtension: false,
			dts: false,
			clean: true,
			deps: {
				neverBundle: [
					/^node:/,
					/^@guessless\/engine(?:\/.*)?$/,
					/^pathe(?:\/.*)?$/,
					/^ufo(?:\/.*)?$/,
				],
				onlyBundle: false,
			},
		},
		{
			name: '@guessless/evaluation',
			cwd: join(rootDir, 'packages/evaluation'),
			entry: { cli: './src/cli.ts' },
			format: ['esm'],
			outDir: './dist',
			platform: 'node',
			fixedExtension: false,
			dts: false,
			clean: true,
			deps: {
				neverBundle: [/^node:/, /^@guessless\/engine(?:\/.*)?$/],
				onlyBundle: false,
			},
		},
	],
	test: {
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					fileParallelism: false,
					// `scripts/` holds the adoption-layer tooling (claim gate, reproduce check).
					// It ships as plain .mjs so target repos can run it straight from a hook or
					// a CI step without a build step, so its suites are included by extension.
					include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.mjs'],
					exclude: ['**/node_modules/**', '**/dist/**', ...evidenceSuites],
					benchmark: { include: ['packages/*/test/**/*.bench.ts'] },
				},
			},
			...(evidenceOptIn
				? [
						{
							test: {
								name: 'evidence',
								environment: 'node' as const,
								fileParallelism: false,
								include: evidenceSuites,
							},
						},
					]
				: []),
		],
	},
	lint: {
		ignorePatterns: [
			'node_modules/**',
			'**/dist/**',
			'.guessless/**',
			'docs/**',
			'packages/engine/test/fixtures/adversarial/parse-failure.ts',
		],
	},
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 100,
		endOfLine: 'lf',
		singleQuote: true,
		ignorePatterns: [
			'node_modules/**',
			'**/dist/**',
			'.guessless/**',
			'docs/**',
			'goal.md',
			'pnpm-lock.yaml',
			'packages/engine/test/fixtures/adversarial/parse-failure.ts',
			// Generator/manifest/deep-verifier-owned bytes; direct summary construction order is integrity-bound.
			'packages/evaluation/fixtures/oracle-part-3-v6/receipts/*.summary.json',
			'packages/evaluation/fixtures/oracle-part-3-v6/replay-contract.json',
			'packages/evaluation/fixtures/oracle-part-3-v6/response.schema.json',
		],
	},
});
