#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiQaServer } from './server.js';

async function main(): Promise<void> {
  const server = createApiQaServer();
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in api-qa-mcp:', error);
  process.exit(1);
});
