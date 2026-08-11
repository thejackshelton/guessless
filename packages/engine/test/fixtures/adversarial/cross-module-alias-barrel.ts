export {
	default,
	default as defaultAggregate,
	transportedAggregate as renamedAggregate,
	transportedTarget as renamedTarget,
} from './cross-module-alias-export.ts';
export * from './cross-module-alias-export.ts';
export * as transportedNamespace from './cross-module-alias-export.ts';
export * from './missing-cross-module-star.ts';
export { missingNamed } from './missing-cross-module-named.ts';
export { default as missingDefault } from './missing-cross-module-default.ts';
export * as missingNamespace from './missing-cross-module-namespace.ts';
export * from 'external-cross-module-export';
export { default as builtinCrossModule } from 'node:fs';
