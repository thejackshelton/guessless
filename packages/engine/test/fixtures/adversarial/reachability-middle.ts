import {
	ArrowRestValue,
	CatchPatternValue,
	ConstructorRestValue,
	FunctionRestValue,
	ImplicitRestValue,
	leaf,
	MethodRestValue,
} from './reachability-leaf.ts';

export function wrapper(): number {
	return leaf();
}

export const wrapperAlias = wrapper;
export default wrapper;
export { leaf as renamedLeaf } from './reachability-leaf.ts';
export * as leafNamespace from './reachability-leaf.ts';

export function catchPattern(): void {
	try {
		throw [{ nested: new CatchPatternValue() }, undefined];
	} catch ([
		{
			nested: { value },
		},
		fallback = leaf(),
	]) {
		void value;
		void fallback;
	}
}

function functionRest(...[{ value }]: [FunctionRestValue]): void {
	void value;
}

export function importedRest(...[{ value }]: [FunctionRestValue]): void {
	void value;
}

const arrowRest = (...[{ value }]: [ArrowRestValue]): void => {
	void value;
};

class MethodRest {
	method(...[{ value }]: [MethodRestValue]): void {
		void value;
	}
}

class ConstructorRest {
	constructor(...[{ value }]: [ConstructorRestValue]) {
		void value;
	}
}

export class RestBase {
	constructor(...[{ value }]: [ImplicitRestValue]) {
		void value;
	}
}

class RestDerived extends RestBase {}

export function restPatterns(): void {
	functionRest(new FunctionRestValue());
	arrowRest(new ArrowRestValue());
	new MethodRest().method(new MethodRestValue());
	new ConstructorRest(new ConstructorRestValue());
	new RestDerived(new ImplicitRestValue());
}
