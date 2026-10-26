import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Database, describeError, type QueryContext } from './db.ts';
import { assertSelectOnly } from './guard.ts';
import {
  FILTER_OPS,
  assertKnownColumns,
  buildCount,
  buildInsert,
  buildSelect,
  type SelectSpec,
} from './sql.ts';

const ident = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain SQL identifier (letters, digits, _)');
const scalar = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
const filter = z.object({
  column: ident,
  op: z.enum(FILTER_OPS),
  value: z.union([scalar, z.array(scalar).max(1000)]).optional(),
});
const orderBy = z.object({ column: ident, direction: z.enum(['asc', 'desc']).optional() });

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

async function tableColumns(q: QueryContext, schema: string, table: string): Promise<ColumnInfo[]> {
  // information_schema.columns only lists columns the current role has some privilege on.
  const res = await q.query<ColumnInfo>(
    `SELECT column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable,
            column_default AS default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  return res.rows;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (args: unknown) => Promise<CallToolResult>;
}

interface ToolMeta<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
}

export function defineTools(db: Database): ToolDef[] {
  const cfg = db.config;
  const tools: ToolDef[] = [];
  function add<S extends z.ZodRawShape>(
    name: string,
    meta: ToolMeta<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) {
    tools.push({
      name,
      title: meta.title,
      description: meta.description,
      // strict: unexpected argument names are rejected instead of silently ignored
      input: z.object(meta.inputSchema).strict(),
      annotations: meta.annotations,
      handler: handler as (args: unknown) => Promise<CallToolResult>,
    });
  }
  const schemaArg = z
    .string()
    .default(cfg.schemas[0]!)
    .refine((s) => cfg.schemas.includes(s), {
      message: `schema must be one of: ${cfg.schemas.join(', ')}`,
    });

  async function knownColumns(
    q: QueryContext,
    schema: string,
    table: string,
  ): Promise<Set<string>> {
    const cols = await tableColumns(q, schema, table);
    if (cols.length === 0) {
      throw new Error(
        `table ${schema}.${table} does not exist or is not visible to role ${cfg.role}`,
      );
    }
    return new Set(cols.map((c) => c.name));
  }

  add(
    'whoami',
    {
      title: 'Connection context',
      description:
        'Shows which Supabase role and user id the server queries as, which schemas are exposed, the row cap and whether SQL and writes are enabled. Never returns credentials.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const db_ = await db.withRls(
          async (q) =>
            (
              await q.query<{ role: string; uid: string | null }>(
                `SELECT current_user AS role, auth.uid()::text AS uid`,
              )
            ).rows[0],
          { readOnly: true },
        );
        return ok({
          role: cfg.role,
          databaseRole: db_?.role,
          userId: db_?.uid ?? null,
          schemas: cfg.schemas,
          maxRows: cfg.maxRows,
          statementTimeoutMs: cfg.statementTimeoutMs,
          sqlEnabled: cfg.allowSql,
          writesEnabled: cfg.allowWrites,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  add(
    'list_tables',
    {
      title: 'List tables',
      description:
        'Lists tables and views in the exposed schemas that the current role can see, with whether row-level security is enabled.',
      inputSchema: { schema: schemaArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ schema }) => {
      try {
        const schemas = schema ? [schema] : cfg.schemas;
        const rows = await db.withRls(
          async (q) =>
            (
              await q.query(
                `SELECT t.table_schema AS schema, t.table_name AS name, t.table_type AS type,
                        coalesce(c.relrowsecurity, false) AS rls_enabled
                   FROM information_schema.tables t
                   LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
                   LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
                  WHERE t.table_schema = ANY($1)
                  ORDER BY 1, 2`,
                [schemas],
              )
            ).rows,
          { readOnly: true },
        );
        return ok({ tables: rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  add(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Columns (name, type, nullability, default), the RLS flag and the names and commands of RLS policies for one table.',
      inputSchema: { schema: schemaArg.optional(), table: ident },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ schema, table }) => {
      const s = schema ?? cfg.schemas[0]!;
      try {
        const out = await db.withRls(
          async (q) => {
            const columns = await tableColumns(q, s, table);
            if (columns.length === 0) {
              throw new Error(
                `table ${s}.${table} does not exist or is not visible to role ${cfg.role}`,
              );
            }
            const rls = await q.query<{ rls_enabled: boolean }>(
              `SELECT c.relrowsecurity AS rls_enabled FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2`,
              [s, table],
            );
            const policies = await q.query(
              `SELECT policyname AS name, cmd AS command, roles::text[] AS roles
                 FROM pg_catalog.pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
              [s, table],
            );
            return {
              schema: s,
              table,
              rlsEnabled: rls.rows[0]?.rls_enabled ?? false,
              columns,
              policies: policies.rows,
            };
          },
          { readOnly: true },
        );
        return ok(out);
      } catch (err) {
        return fail(err);
      }
    },
  );

  add(
    'select_rows',
    {
      title: 'Select rows',
      description: `Reads rows from one table with structured filters (${FILTER_OPS.join(', ')}), ordering and a limit of at most ${cfg.maxRows}. Rows are filtered by RLS for role ${cfg.role}. No raw SQL.`,
      inputSchema: {
        schema: schemaArg.optional(),
        table: ident,
        columns: z.array(ident).max(100).optional(),
        filters: z.array(filter).max(20).optional(),
        orderBy: z.array(orderBy).max(5).optional(),
        limit: z.number().int().min(1).max(cfg.maxRows).default(Math.min(50, cfg.maxRows)),
        offset: z.number().int().min(0).max(100_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const spec: SelectSpec = { ...args, schema: args.schema ?? cfg.schemas[0]! };
      try {
        const rows = await db.withRls(
          async (q) => {
            assertKnownColumns(spec, await knownColumns(q, spec.schema, spec.table));
            const { text, values } = buildSelect(spec);
            return (await q.query(text, values)).rows;
          },
          { readOnly: true },
        );
        return ok({ rowCount: rows.length, limit: spec.limit, rows });
      } catch (err) {
        return fail(err);
      }
    },
  );

  add(
    'count_rows',
    {
      title: 'Count rows',
      description:
        'Counts rows visible to the current role, with the same structured filters as select_rows.',
      inputSchema: {
        schema: schemaArg.optional(),
        table: ident,
        filters: z.array(filter).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const spec = { ...args, schema: args.schema ?? cfg.schemas[0]!, limit: 1 };
      try {
        const count = await db.withRls(
          async (q) => {
            assertKnownColumns(spec, await knownColumns(q, spec.schema, spec.table));
            const { text, values } = buildCount(spec);
            return Number((await q.query<{ count: string }>(text, values)).rows[0]?.count ?? 0);
          },
          { readOnly: true },
        );
        return ok({ count });
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (cfg.allowSql) {
    add(
      'run_select_sql',
      {
        title: 'Run read-only SQL',
        description: `Runs one SELECT/WITH statement in a READ ONLY transaction as role ${cfg.role} (RLS applies), with a ${cfg.statementTimeoutMs} ms timeout. At most ${cfg.maxRows} rows are returned.`,
        inputSchema: { sql: z.string().min(1).max(20_000) },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ sql }) => {
        try {
          const stmt = assertSelectOnly(sql);
          const rows = await db.withRls(
            async (q) =>
              // newline so a trailing -- comment in stmt cannot swallow the wrapper
              (await q.query(`SELECT * FROM (\n${stmt}\n) AS mcp_q LIMIT ${cfg.maxRows + 1}`)).rows,
            { readOnly: true },
          );
          const truncated = rows.length > cfg.maxRows;
          return ok({
            rowCount: Math.min(rows.length, cfg.maxRows),
            truncated,
            rows: rows.slice(0, cfg.maxRows),
          });
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (cfg.allowWrites) {
    add(
      'insert_row',
      {
        title: 'Insert one row',
        description: `Inserts one row as role ${cfg.role}. RLS insert policies decide whether it is allowed. Returns the inserted row.`,
        inputSchema: {
          schema: schemaArg.optional(),
          table: ident,
          row: z.record(ident, scalar),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ schema, table, row }) => {
        const s = schema ?? cfg.schemas[0]!;
        try {
          const inserted = await db.withRls(
            async (q) => {
              const known = await knownColumns(q, s, table);
              const unknown = Object.keys(row).filter((c) => !known.has(c));
              if (unknown.length)
                throw new Error(`unknown column(s) on ${s}.${table}: ${unknown.join(', ')}`);
              const { text, values } = buildInsert(s, table, row);
              return (await q.query(text, values)).rows[0];
            },
            { readOnly: false },
          );
          return ok({ inserted });
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  return tools;
}
