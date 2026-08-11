/* eslint-disable no-import-assign -- planted semantic write fixtures */
import { target } from './definitions.ts';
import * as definitions from './definitions.ts';

declare const source: { value: number };
declare const values: number[];

export const directWriteForms = () => {
	({ value: target } = source);
	for (target of values) void target;
	for (target in source) void target;
};

export const namespaceWriteForms = () => {
	({ value: definitions.target } = source);
	for (definitions.target of values) void definitions.target;
	for (definitions.target in source) void definitions.target;
	delete definitions.target;
};
