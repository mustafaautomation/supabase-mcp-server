// Runs the built server (dist/) as a child process over stdio, the way Claude Desktop and Claude
// Code start it. Requires `npm run build` and a database (see tests/integration/helpers.ts).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ALICE, DATABASE_URL, ensureSchema } from '../integration/helpers.ts';

const entry = join(import.meta.dirname, '..', '..', 'dist', 'src', 'index.js');

describe('stdio server process', () => {
  let client: Client;
  let stderr = '';

  beforeAll(async () => {
    await ensureSchema();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        DATABASE_URL,
        MCP_DB_ROLE: 'authenticated',
        MCP_USER_ID: ALICE,
        PATH: process.env.PATH ?? '',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => (stderr += String(d)));
    client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => client?.close());

  it('negotiates the latest protocol version the SDK supports and identifies itself', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'supabase-mcp-server' });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('lists tools with object input schemas and descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(5);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description?.length).toBeGreaterThan(20);
    }
  });

  it('answers a tool call from the database as the configured user', async () => {
    const r = (await client.callTool({
      name: 'select_rows',
      arguments: { table: 'projects', columns: ['name'] },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.structuredContent)).toContain('Alice private');
  });

  it('reports invalid arguments as a tool error and stays up', async () => {
    const bad = (await client.callTool({
      name: 'select_rows',
      arguments: { table: 42 },
    })) as CallToolResult;
    expect(bad.isError).toBe(true);
    const again = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult;
    expect(again.isError).toBeFalsy();
  });

  it('rejects an unknown tool', async () => {
    const r = (await client
      .callTool({ name: 'drop_database', arguments: {} })
      .catch((e: Error) => ({
        isError: true,
        content: [{ type: 'text', text: e.message }],
      }))) as CallToolResult;
    expect(r.isError).toBe(true);
  });

  it('logs to stderr only and never prints the connection string', () => {
    expect(stderr).toContain('role=authenticated');
    expect(stderr).not.toContain(DATABASE_URL);
  });
});

describe('startup with bad configuration', () => {
  it('exits with code 2 and a readable message', () => {
    const r = spawnSync(process.execPath, [entry], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL, MCP_DB_ROLE: 'authenticated' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/MCP_USER_ID/);
  });
});
