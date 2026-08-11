import { sendTelemetry } from './barrel';
export const higherOrder = (): number => sendTelemetry('higher');
