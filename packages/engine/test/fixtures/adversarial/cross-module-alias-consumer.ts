import directDefault, { transportedAggregate } from './cross-module-alias-export.ts';
import chainedDefault, {
	defaultAggregate,
	renamedAggregate,
	transportedAggregate as starredAggregate,
	transportedNamespace,
} from './cross-module-alias-barrel.ts';
import * as aggregateNamespace from './cross-module-alias-barrel.ts';
import type { ExternalCrossModule } from 'external-cross-module';
import type { MissingCrossModule } from './missing-cross-module.ts';

declare const namespaceKey: string;
declare function opaqueCrossModule(input: unknown): { chosen: typeof transportedAggregate.chosen };

transportedAggregate.chosen.namedWrite = 1;
directDefault.anonymousChosen.defaultUpdate++;
delete defaultAggregate.anonymousChosen.defaultDelete;
chainedDefault.anonymousChosen.defaultChainWrite = 1;
renamedAggregate.chosen.reexportAssignment += 1;
starredAggregate.chosen.starWrite = 2;
aggregateNamespace.transportedAggregate.chosen.namespaceWrite = 3;
aggregateNamespace.renamedAggregate.chosen.namespaceReexportWrite = 4;
transportedNamespace.default.anonymousChosen.namespaceDefaultWrite = 5;
aggregateNamespace.transportedNamespace.default.anonymousChosen.namespaceImportUpdate++;
delete transportedNamespace.transportedAggregate.chosen.namespaceDelete;
transportedNamespace.definitionNamespace.target.multiHopNamespaceWrite = 6;

const { chosen: destructuredAcrossModule } = transportedAggregate;
destructuredAcrossModule.destructuredWrite = 5;
const spreadAcrossModule = { ...renamedAggregate };
spreadAcrossModule.chosen.spreadWrite = 6;
const opaqueAcrossModule = opaqueCrossModule(starredAggregate);
opaqueAcrossModule.chosen.opaqueWrite = 7;
const { default: namespaceDefault } = transportedNamespace;
namespaceDefault.anonymousChosen.namespaceDestructuredWrite = 8;
const { transportedTarget: excludedNamespaceTarget, ...namespaceRest } = transportedNamespace;
namespaceRest.default.anonymousChosen.namespaceRestWrite = 9;
void excludedNamespaceTarget;
const namespaceSpread = { ...transportedNamespace };
namespaceSpread.default.anonymousChosen.namespaceSpreadWrite = 10;
const opaqueNamespaceSelected = opaqueCrossModule(transportedNamespace.default);
opaqueNamespaceSelected.chosen.namespaceOpaqueWrite = 11;

const dynamicNamespaceAggregate = aggregateNamespace[namespaceKey];
dynamicNamespaceAggregate.chosen.dynamicNamespaceWrite = 8;
const dynamicTransportedNamespace = transportedNamespace[namespaceKey];
dynamicTransportedNamespace.chosen.dynamicTransportedNamespaceWrite = 12;

transportedAggregate.containerOnly = true;
renamedAggregate.sibling.negativeSibling = true;
directDefault.anonymousSibling.negativeAnonymousSibling = true;
transportedNamespace.containerOnly = true;
transportedNamespace.transportedAggregate.sibling.negativeNamespaceSibling = true;

void (0 as unknown as ExternalCrossModule);
void (0 as unknown as MissingCrossModule);
