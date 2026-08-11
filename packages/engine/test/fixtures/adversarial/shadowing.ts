import { target } from './definitions.ts';
export const importedRead = () => target;
export const shadowedRead = () => {
	const target = 'local';
	return target;
};
