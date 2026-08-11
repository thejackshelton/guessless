import builtinEffect from 'node:fs';
import externalEffect from 'external-effect';
import missingEffect from './missing-reachability.ts';
import type { FunctionRestValue } from './reachability-leaf.ts';
import { importedRest } from './reachability-middle.ts';

declare function makeFactory(): () => void;
declare const effectKey: string;
declare const effects: Record<string, () => void>;

export function boundaryWrapper(): void {
	builtinEffect();
	externalEffect();
	missingEffect();
	effects[effectKey]();
	makeFactory()();
	ambiguousCatch(true);
	ambiguousRest([]);
}

function ambiguousCatch(flag: boolean): void {
	try {
		if (flag) throw { value: 1 };
		throw { value: 2 };
	} catch ({ value }) {
		void value;
	}
}

function ambiguousRest(values: FunctionRestValue[]): void {
	importedRest(...values);
}
