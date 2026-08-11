#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGuesslessMcpServer, GuesslessEngine } from './index.ts';

export async function runStdioServer(engine?: InstanceType<typeof GuesslessEngine>): Promise<void> {
	const server = createGuesslessMcpServer(engine);
	await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && fileURLToPath(import.meta.url) === invokedPath) await runStdioServer();
