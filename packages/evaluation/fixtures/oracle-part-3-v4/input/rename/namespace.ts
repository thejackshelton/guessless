import * as telemetry from './api';
export const namespaced = (): number => telemetry.sendTelemetry('namespace');
