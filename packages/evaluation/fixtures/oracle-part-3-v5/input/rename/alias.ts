import { sendTelemetry as send } from './api';
export const aliased = (): number => send('alias');
