import pg from 'pg';
import type { Config } from './config.ts';

export interface QueryContext {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export class Database {
  readonly pool: pg.Pool;
  readonly config: Config;

  constructor(config: Config, pool?: pg.Pool) {
    this.config = config;
    this.pool = pool ?? new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  }

  /**
   * Runs fn inside a transaction that has switched to the configured Supabase role and carries
   * the same JWT claims PostgREST would set, so auth.uid() and every RLS policy apply exactly as
   * they would for a supabase-js client using that user's session.
   */
  async withRls<T>(fn: (q: QueryContext) => Promise<T>, opts: { readOnly: boolean }): Promise<T> {
    const { role, userId, statementTimeoutMs } = this.config;
    const client = await this.pool.connect();
    try {
      await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      // role is one of two literals validated by zod; it is never client input.
      await client.query(`SET LOCAL ROLE ${role === 'anon' ? 'anon' : 'authenticated'}`);
      const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
      await client.query(
        `SELECT set_config('statement_timeout', $1, true),
                set_config('request.jwt.claims', $2, true),
                set_config('request.jwt.claim.sub', $3, true),
                set_config('request.jwt.claim.role', $4, true)`,
        [String(statementTimeoutMs), claims, userId ?? '', role],
      );
      const result = await fn({ query: (text, values) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Turns a pg error into a message that is safe to hand back to a model. */
export function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code?: string; message: string };
    const hint: Record<string, string> = {
      '42501': 'permission denied (row-level security or grants)',
      '25006': 'the transaction is read-only',
      '57014': 'statement timeout',
      '42P01': 'relation does not exist or is not visible to this role',
      '42703': 'column does not exist',
      '22P02': 'invalid input value for the column type',
    };
    const known = e.code ? hint[e.code] : undefined;
    return `${e.message}${e.code ? ` [${e.code}${known ? `: ${known}` : ''}]` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}
