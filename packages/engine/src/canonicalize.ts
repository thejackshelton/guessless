import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new TypeError('canonical JSON cannot contain non-finite numbers');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(',')}}`;
	}
	throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

export function sha256(value: unknown): string {
	return createHash('sha256').update(canonicalize(value)).digest('hex');
}
