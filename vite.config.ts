import { join } from 'node:path';
import { defineConfig } from 'vite-plus';

const rootDir = import.meta.dirname;

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
					include: ['packages/*/test/**/*.test.ts'],
					benchmark: { include: ['packages/*/test/**/*.bench.ts'] },
				},
			},
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
