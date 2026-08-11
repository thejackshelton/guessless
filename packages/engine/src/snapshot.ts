import type { Analyzer } from 'yuku-analyzer';
import { sha256 } from './canonicalize.ts';

export function analyzerSnapshot(analyzer: Analyzer): string {
	return sha256(
		[...analyzer.modules.values()]
			.map((module) => ({ path: module.path, source: module.source }))
			.sort((a, b) => a.path.localeCompare(b.path)),
	);
}
