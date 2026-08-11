import { sendTelemetry } from './api';
export const direct = (): number => sendTelemetry('direct');
