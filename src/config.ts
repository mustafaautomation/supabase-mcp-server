import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    MCP_DB_ROLE: z.enum(['anon', 'authenticated']).default('anon'),
    MCP_USER_ID: z.uuid().optional(),
    MCP_SCHEMAS: z
      .string()
      .default('public')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/, 'invalid schema name')).min(1)),
    MCP_MAX_ROWS: z.coerce.number().int().min(1).max(1000).default(100),
    MCP_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    MCP_ALLOW_SQL: bool,
    MCP_ALLOW_WRITES: bool,
  })
  .superRefine((env, ctx) => {
    if (env.MCP_DB_ROLE === 'authenticated' && !env.MCP_USER_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_USER_ID'],
        message: 'MCP_USER_ID (a uuid) is required when MCP_DB_ROLE=authenticated',
      });
    }
    if (env.MCP_DB_ROLE === 'anon' && env.MCP_USER_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_USER_ID'],
        message: 'MCP_USER_ID must not be set when MCP_DB_ROLE=anon',
      });
    }
  });

export interface Config {
  databaseUrl: string;
  role: 'anon' | 'authenticated';
  userId: string | undefined;
  schemas: string[];
  maxRows: number;
  statementTimeoutMs: number;
  allowSql: boolean;
  allowWrites: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    role: e.MCP_DB_ROLE,
    userId: e.MCP_USER_ID,
    schemas: e.MCP_SCHEMAS,
    maxRows: e.MCP_MAX_ROWS,
    statementTimeoutMs: e.MCP_STATEMENT_TIMEOUT_MS,
    allowSql: e.MCP_ALLOW_SQL,
    allowWrites: e.MCP_ALLOW_WRITES,
  };
}
