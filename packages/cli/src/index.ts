import type { QueryRequest, Receipt, SymbolAnchor } from '../../engine/src/index.ts';

const enginePackage: string = '@guessless/engine';
const { GuesslessEngine, isAnchor, receiptCanonicalForm, verifyReceipt } = (await import(
	enginePackage
)) as typeof import('../../engine/src/index.ts');

type InputFile = { readonly path: string; readonly source: string };
type QueryEnvelope = { readonly inputs: readonly InputFile[]; readonly request: QueryRequest };
type ReproduceEnvelope = {
	readonly inputs: readonly InputFile[];
	readonly receipt: Receipt<unknown>;
};

export interface CliExecution {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

const targetKinds = new Set([
	'definitionOf',
	'referencesOf',
	'readsOf',
	'writesOf',
	'capturesOf',
	'reachableFrom',
	'reaches',
]);
const bindingSpaces = new Set(['value', 'type', 'namespace', 'typeof', 'any']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function parseDocument(document: string): unknown {
	try {
		return JSON.parse(document);
	} catch {
		throw new TypeError('input must be exactly one valid JSON document');
	}
}

function parseInputs(value: unknown): readonly InputFile[] {
	if (!Array.isArray(value)) throw new TypeError('inputs must be an ordered array');
	const inputs = value.map((input) => {
		if (
			!isRecord(input) ||
			!hasExactKeys(input, ['path', 'source']) ||
			typeof input.path !== 'string' ||
			typeof input.source !== 'string'
		)
			throw new TypeError('each input must contain exactly string path and source fields');
		return { path: input.path, source: input.source };
	});
	if (new Set(inputs.map((input) => input.path)).size !== inputs.length)
		throw new TypeError('duplicate logical input paths are not allowed');
	return inputs;
}

function parseRequest(value: unknown): QueryRequest {
	if (!isRecord(value) || typeof value.kind !== 'string')
		throw new TypeError('request must be an object with a supported kind');
	if (targetKinds.has(value.kind)) {
		if (!hasExactKeys(value, ['kind', 'target']) || !isAnchor(value.target))
			throw new TypeError(`invalid ${value.kind} request`);
		return value as QueryRequest;
	}
	if (value.kind === 'exportedNames') {
		if (!hasExactKeys(value, ['file', 'kind']) || typeof value.file !== 'string')
			throw new TypeError('invalid exportedNames request');
		return value as QueryRequest;
	}
	if (value.kind === 'resolveBinding') {
		const keys = Object.keys(value).sort().join('\0');
		const withoutScope = ['file', 'kind', 'name', 'space'].sort().join('\0');
		const withScope = ['file', 'kind', 'name', 'scope', 'space'].sort().join('\0');
		if (
			(keys !== withoutScope && keys !== withScope) ||
			typeof value.file !== 'string' ||
			typeof value.name !== 'string' ||
			!bindingSpaces.has(String(value.space)) ||
			('scope' in value && value.scope !== null && !isAnchor(value.scope))
		)
			throw new TypeError('invalid resolveBinding request');
		return {
			kind: 'resolveBinding',
			file: value.file,
			name: value.name,
			space: value.space as 'value' | 'type' | 'namespace' | 'typeof' | 'any',
			scope: ('scope' in value ? value.scope : null) as SymbolAnchor | null,
		};
	}
	throw new TypeError(`unsupported query kind '${value.kind}'`);
}

function parseQueryEnvelope(value: unknown): QueryEnvelope {
	if (!isRecord(value) || !hasExactKeys(value, ['inputs', 'request']))
		throw new TypeError('query envelope must contain exactly inputs and request');
	return { inputs: parseInputs(value.inputs), request: parseRequest(value.request) };
}

function parseReproduceEnvelope(value: unknown): ReproduceEnvelope {
	if (!isRecord(value) || !hasExactKeys(value, ['inputs', 'receipt']))
		throw new TypeError('reproduce envelope must contain exactly inputs and receipt');
	const inputs = parseInputs(value.inputs);
	if (!verifyReceipt(value.receipt))
		throw new TypeError('supplied receipt failed integrity validation');
	const receipt = value.receipt as Receipt<unknown>;
	if (receipt.request.kind === 'addFile') {
		if (receipt.state !== 'refused')
			throw new TypeError('addFile reproduction requires a refused receipt');
	} else {
		parseRequest(receipt.request);
	}
	return { inputs, receipt };
}

function loadEngine(inputs: readonly InputFile[]):
	| { readonly engine: InstanceType<typeof GuesslessEngine> }
	| {
			readonly engine: InstanceType<typeof GuesslessEngine>;
			readonly refusal: Receipt<unknown>;
	  } {
	const engine = new GuesslessEngine();
	for (const input of inputs) {
		const added = engine.addFile(input.path, input.source);
		if ('schema' in added) return { engine, refusal: added };
	}
	engine.link();
	return { engine };
}

function dispatch(
	engine: InstanceType<typeof GuesslessEngine>,
	request: QueryRequest,
): Receipt<unknown> {
	switch (request.kind) {
		case 'definitionOf':
			return engine.definitionOf(request.target);
		case 'referencesOf':
			return engine.referencesOf(request.target);
		case 'readsOf':
			return engine.readsOf(request.target);
		case 'writesOf':
			return engine.writesOf(request.target);
		case 'exportedNames':
			return engine.exportedNames(request.file);
		case 'capturesOf':
			return engine.capturesOf(request.target);
		case 'resolveBinding':
			return engine.resolveBinding(
				request.file,
				request.name,
				request.space,
				request.scope ?? undefined,
			);
		case 'reachableFrom':
			return engine.reachableFrom(request.target);
		case 'reaches':
			return engine.reaches(request.target);
		default:
			throw new TypeError('unsupported query request');
	}
}

function receiptOutput(receipt: Receipt<unknown>, exitCode: number, stderr = ''): CliExecution {
	return { stdout: `${JSON.stringify(receipt)}\n`, stderr, exitCode };
}

function failure(error: unknown): CliExecution {
	const detail = error instanceof Error ? error.message : String(error);
	return { stdout: '', stderr: `guessless: ${detail}\n`, exitCode: 2 };
}

export function executeQuery(document: string): CliExecution {
	try {
		const envelope = parseQueryEnvelope(parseDocument(document));
		const loaded = loadEngine(envelope.inputs);
		if ('refusal' in loaded)
			return receiptOutput(
				loaded.refusal,
				1,
				'guessless: an input file was refused by the engine\n',
			);
		return receiptOutput(dispatch(loaded.engine, envelope.request), 0);
	} catch (error) {
		return failure(error);
	}
}

export function executeReproduce(document: string): CliExecution {
	try {
		const envelope = parseReproduceEnvelope(parseDocument(document));
		const loaded = loadEngine(envelope.inputs);
		if ('refusal' in loaded) {
			const identical =
				loaded.engine.verify(envelope.receipt) &&
				receiptCanonicalForm(loaded.refusal) === receiptCanonicalForm(envelope.receipt);
			return receiptOutput(
				loaded.refusal,
				identical ? 0 : 1,
				identical
					? ''
					: 'guessless: generated input refusal does not reproduce canonically\n',
			);
		}
		if (envelope.receipt.request.kind === 'addFile')
			return {
				stdout: '',
				stderr: 'guessless: reproduction inputs produced no addFile refusal\n',
				exitCode: 1,
			};
		const current = dispatch(loaded.engine, envelope.receipt.request);
		const identical =
			loaded.engine.verify(envelope.receipt) &&
			receiptCanonicalForm(current) === receiptCanonicalForm(envelope.receipt);
		return receiptOutput(
			current,
			identical ? 0 : 1,
			identical ? '' : 'guessless: supplied receipt does not reproduce canonically\n',
		);
	} catch (error) {
		return failure(error);
	}
}

export function executeCommand(command: string, document: string): CliExecution {
	if (command === 'query') return executeQuery(document);
	if (command === 'reproduce') return executeReproduce(document);
	return failure(new TypeError(`unknown command '${command}'`));
}
