import { target } from './definitions.ts';
import * as definitions from './definitions.ts';
declare const key: string;

export const duplicateReferences = () => {
	void target;
	void target;
	void definitions[key];
	void definitions[key];
};
