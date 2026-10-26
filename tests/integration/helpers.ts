import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.ts';
import { createServer } from '../../src/server.ts';

// Default: the database started by `supabase start` / `supabase db start`.
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

const root = join(import.meta.dirname, '..', '..');

/**
 * Makes sure the demo schema exists. Against a Supabase stack the CLI has already applied the
 * migration and seed; against plain Postgres this applies a small shim (roles + auth.uid()),
 * then the same migration and seed files.
 */
export async function ensureSchema(): Promise<void> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    const hasAuth = await c.query(`select to_regprocedure('auth.uid()') is not null as ok`);
    if (!hasAuth.rows[0].ok) {
      await c.query(readFileSync(join(root, 'tests/sql/plain-postgres-shim.sql'), 'utf8'));
    }
    const hasTables = await c.query(`select to_regclass('public.projects') is not null as ok`);
    if (!hasTables.rows[0].ok) {
      const dir = join(root, 'supabase/migrations');
      for (const f of readdirSync(dir).sort()) await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'));
    }
  } finally {
    await c.end();
  }
}

/** Runs SQL as the connection owner, bypassing the server (for setup and cleanup only). */
export async function adminQuery(text: string, values?: unknown[]) {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await c.query(text, values);
  } finally {
    await c.end();
  }
}

export async function connect(env: Record<string, string> = {}) {
  const config = loadConfig({ DATABASE_URL, ...env });
  const { server, db } = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'integration-test', version: '0.0.0' });
  await client.connect(clientT);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
      await db.close();
    },
  };
}

export function data<T = Record<string, unknown>>(r: CallToolResult): T {
  if (r.isError) throw new Error(`tool error: ${JSON.stringify(r.content)}`);
  return r.structuredContent as T;
}

export function errorText(r: CallToolResult): string {
  expectError(r);
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function expectError(r: CallToolResult) {
  if (!r.isError)
    throw new Error(`expected a tool error, got ${JSON.stringify(r.structuredContent)}`);
}
