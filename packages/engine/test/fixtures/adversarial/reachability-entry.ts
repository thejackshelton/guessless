import { invoke, retain } from './higher-order.ts';
import { boundaryWrapper } from './reachability-boundaries.ts';
import { cycleA } from './reachability-cycle.ts';
import { callbackLeaf, FunctionRestValue, ImplicitRestValue } from './reachability-leaf.ts';
import defaultWrapper, {
	catchPattern,
	importedRest,
	leafNamespace,
	renamedLeaf,
	RestBase,
	restPatterns,
	wrapperAlias,
} from './reachability-middle.ts';

class CrossModuleDerived extends RestBase {}

export const dependencyEntry = () => [
	defaultWrapper,
	wrapperAlias,
	renamedLeaf,
	leafNamespace.leaf,
];

export function completeEntry(): void {
	defaultWrapper();
	invoke(callbackLeaf);
	leafNamespace.leaf();
	cycleA();
	catchPattern();
	restPatterns();
	importedRest(new FunctionRestValue());
	new CrossModuleDerived(new ImplicitRestValue());
}

export function partialEntry(): void {
	completeEntry();
	boundaryWrapper();
	retain(callbackLeaf);
}
