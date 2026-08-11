export function cycleA(): void {
	cycleB();
}

export function cycleB(): void {
	cycleA();
}
