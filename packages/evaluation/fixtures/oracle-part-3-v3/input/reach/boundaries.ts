export async function unresolvedBoundary(): Promise<unknown> {
	const externalName = 'external-' + 'boundary';
	return import(externalName);
}
