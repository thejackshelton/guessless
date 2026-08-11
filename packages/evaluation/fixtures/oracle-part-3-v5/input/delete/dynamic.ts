export async function dynamicRead(): Promise<unknown> {
	const state = await import('./state');
	return (state as unknown as Record<string, unknown>)['legacy' + 'Flag'];
}
