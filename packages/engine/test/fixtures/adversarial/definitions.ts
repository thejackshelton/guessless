export let target = 0;
export const readTarget = () => target;
export const writeTarget = () => target++;
export const makeClosure = (prefix: string) => () => `${prefix}:${target}`;
