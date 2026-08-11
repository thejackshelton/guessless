export const leafValue = 7;

export function leaf(): number {
	return leafValue;
}

export function callbackLeaf(): number {
	return leaf();
}

export function catchPatternLeaf(): void {}
export function functionRestLeaf(): void {}
export function arrowRestLeaf(): void {}
export function methodRestLeaf(): void {}
export function constructorRestLeaf(): void {}
export function implicitRestLeaf(): void {}

export class CatchPatternValue {
	get value(): number {
		catchPatternLeaf();
		return 1;
	}
}

export class FunctionRestValue {
	get value(): number {
		functionRestLeaf();
		return 1;
	}
}

export class ArrowRestValue {
	get value(): number {
		arrowRestLeaf();
		return 1;
	}
}

export class MethodRestValue {
	get value(): number {
		methodRestLeaf();
		return 1;
	}
}

export class ConstructorRestValue {
	get value(): number {
		constructorRestLeaf();
		return 1;
	}
}

export class ImplicitRestValue {
	get value(): number {
		implicitRestLeaf();
		return 1;
	}
}
