import { target } from './definitions.ts';
const apply = <T>(fn: () => T): T => fn();
export const throughWrapper = () => apply(() => target);

export function invoke<T>(callback: () => T): T {
	return callback();
}

export function retain<T>(callback: () => T): () => T {
	return callback;
}
