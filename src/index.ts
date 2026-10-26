#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  const { server, db, tools } = createServer(config);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // stdout carries the protocol; everything else goes to stderr.
  console.error(
    `supabase-mcp-server: role=${config.role} schemas=${config.schemas.join(',')} tools=${tools.join(',')}`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
