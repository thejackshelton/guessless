import { unresolvedBoundary } from './boundaries';
import { cycleA } from './cycle';
import { leaf } from './leaf';
export function start(): number {
	void unresolvedBoundary();
	return leaf() + cycleA();
}
