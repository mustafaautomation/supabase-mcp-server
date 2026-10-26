import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { Database } from './db.ts';
import { defineTools } from './tools.ts';

export const SERVER_NAME = 'supabase-mcp-server';
export const SERVER_VERSION = '0.1.0';

/**
 * Uses the SDK's low-level Server so error handling follows the spec exactly:
 * an unknown tool is a JSON-RPC protocol error (-32602), while invalid arguments and database
 * errors come back as tool results with isError: true, which the model can read and correct.
 */
export function createServer(config: Config, db = new Database(config)) {
  const defs = defineTools(db);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        `Read-mostly access to a Supabase Postgres database as role "${config.role}". ` +
        'Row-level security applies to every query. Use list_tables and describe_table first, then select_rows or count_rows.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defs.map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      inputSchema: z.toJSONSchema(d.input, { io: 'input' }) as { type: 'object' },
      annotations: d.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const def = byName.get(req.params.name);
    if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
    const parsed = def.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
        .join('; ');
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid arguments for ${def.name}: ${issues}` }],
      };
    }
    return def.handler(parsed.data);
  });

  return { server, db, tools: defs.map((d) => d.name) };
}
