import * as definitions from './definitions.ts';

export const namespaceWrites = () => {
	void definitions.target;
	// eslint-disable-next-line no-import-assign -- planted semantic mutation fixture
	definitions.target = 1;
	// eslint-disable-next-line no-import-assign -- planted semantic mutation fixture
	definitions.target++;
	// eslint-disable-next-line no-import-assign -- planted semantic mutation fixture
	definitions.target += 2;
};
