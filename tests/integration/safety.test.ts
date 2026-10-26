import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE, BOB, adminQuery, connect, data, ensureSchema, errorText } from './helpers.ts';
import { Database } from '../../src/db.ts';
import { loadConfig } from '../../src/config.ts';
import { DATABASE_URL } from './helpers.ts';

beforeAll(ensureSchema);
afterAll(async () => {
  await adminQuery(`delete from public.projects where name like 'mcp-test-%'`);
});

describe('input validation', () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => (s = await connect({ MCP_MAX_ROWS: '3' })));
  afterAll(() => s.close());

  it('rejects identifiers that are not plain names before touching the database', async () => {
    const r = await s.call('select_rows', { table: 'projects"; drop table projects; --' });
    expect(r.isError).toBe(true);
    expect(errorText(r)).toMatch(/identifier/);
  });

  it('rejects unknown columns using the live catalog', async () => {
    expect(
      errorText(await s.call('select_rows', { table: 'projects', columns: ['password'] })),
    ).toMatch(/unknown column\(s\) on public\.projects: password/);
    expect(
      errorText(
        await s.call('count_rows', {
          table: 'projects',
          filters: [{ column: 'nope', op: 'eq', value: 1 }],
        }),
      ),
    ).toMatch(/nope/);
  });

  it('treats injection attempts in values as data', async () => {
    const r = data<{ rowCount: number }>(
      await s.call('select_rows', {
        table: 'projects',
        filters: [{ column: 'name', op: 'eq', value: "x' or '1'='1" }],
      }),
    );
    expect(r.rowCount).toBe(0);
  });

  it('enforces the configured row cap in the schema', async () => {
    expect((await s.call('select_rows', { table: 'tasks', limit: 4 })).isError).toBe(true);
    expect(
      data<{ rowCount: number }>(await s.call('select_rows', { table: 'tasks', limit: 3 }))
        .rowCount,
    ).toBeLessThanOrEqual(3);
  });

  it('only allows the configured schemas', async () => {
    expect(errorText(await s.call('select_rows', { schema: 'auth', table: 'users' }))).toMatch(
      /schema must be one of/,
    );
    expect(errorText(await s.call('list_tables', { schema: 'pg_catalog' }))).toMatch(
      /schema must be one of/,
    );
  });

  it('returns a tool error, not a protocol crash, for bad value types', async () => {
    const r = await s.call('select_rows', {
      table: 'projects',
      filters: [{ column: 'id', op: 'eq', value: 'abc' }],
    });
    expect(errorText(r)).toMatch(/22P02/);
  });
});

describe('write and SQL tools are opt-in', () => {
  it('are not listed by default', async () => {
    const s = await connect();
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['count_rows', 'describe_table', 'list_tables', 'select_rows', 'whoami']);
    await s.close();
  });

  it('every default tool is annotated read-only', async () => {
    const s = await connect();
    for (const t of (await s.client.listTools()).tools)
      expect(t.annotations?.readOnlyHint).toBe(true);
    await s.close();
  });
});

describe('run_select_sql (MCP_ALLOW_SQL=true)', () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(
    async () =>
      (s = await connect({
        MCP_ALLOW_SQL: 'true',
        MCP_DB_ROLE: 'authenticated',
        MCP_USER_ID: BOB,
        MCP_STATEMENT_TIMEOUT_MS: '500',
        MCP_MAX_ROWS: '2',
      })),
  );
  afterAll(() => s.close());

  it('runs a SELECT under RLS', async () => {
    const r = data<{ rows: Array<{ name: string }> }>(
      await s.call('run_select_sql', {
        sql: "select name from public.projects where name like '%private'",
      }),
    );
    expect(r.rows.map((x) => x.name)).toEqual(['Bob private']);
  });

  it('truncates to the row cap and says so', async () => {
    const r = data<{ rowCount: number; truncated: boolean }>(
      await s.call('run_select_sql', {
        sql: 'select g from generate_series(1, 10) g -- trailing comment',
      }),
    );
    expect(r).toMatchObject({ rowCount: 2, truncated: true });
  });

  it('rejects DML and multiple statements', async () => {
    expect(errorText(await s.call('run_select_sql', { sql: 'delete from public.tasks' }))).toMatch(
      /only SELECT/,
    );
    expect(errorText(await s.call('run_select_sql', { sql: 'select 1; select 2' }))).toMatch(
      /single statement/,
    );
  });

  it('a write hidden in a function call still fails because the transaction is read-only', async () => {
    const r = await s.call('run_select_sql', { sql: "select nextval('public.projects_id_seq')" });
    expect(errorText(r)).toMatch(/25006|read-only|permission denied/);
  });

  it('stops long queries with the statement timeout', async () => {
    expect(errorText(await s.call('run_select_sql', { sql: 'select pg_sleep(3)' }))).toMatch(
      /57014/,
    );
  });
});

describe('the database layer itself is read-only for read tools', () => {
  it('rejects an INSERT inside a readOnly transaction even as the owner of a row', async () => {
    const db = new Database(
      loadConfig({ DATABASE_URL, MCP_DB_ROLE: 'authenticated', MCP_USER_ID: ALICE }),
    );
    await expect(
      db.withRls((q) => q.query(`insert into public.projects (name) values ('mcp-test-ro')`), {
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: '25006' });
    await db.close();
  });
});

describe('insert_row (MCP_ALLOW_WRITES=true)', () => {
  let alice: Awaited<ReturnType<typeof connect>>;
  let anon: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    alice = await connect({
      MCP_ALLOW_WRITES: 'true',
      MCP_DB_ROLE: 'authenticated',
      MCP_USER_ID: ALICE,
    });
    anon = await connect({ MCP_ALLOW_WRITES: 'true' });
  });
  afterAll(async () => {
    await alice.close();
    await anon.close();
  });

  it('inserts as the configured user, with owner_id filled by auth.uid()', async () => {
    const r = data<{ inserted: { name: string; owner_id: string } }>(
      await alice.call('insert_row', { table: 'projects', row: { name: 'mcp-test-alice' } }),
    );
    expect(r.inserted).toMatchObject({ name: 'mcp-test-alice', owner_id: ALICE });
  });

  it('RLS blocks inserting a row owned by someone else', async () => {
    expect(
      errorText(
        await alice.call('insert_row', {
          table: 'projects',
          row: { name: 'mcp-test-spoof', owner_id: BOB },
        }),
      ),
    ).toMatch(/42501/);
  });

  it("RLS blocks adding a task to another user's project", async () => {
    const bobProject = (
      await adminQuery(`select id from public.projects where name = 'Bob private'`)
    ).rows[0].id;
    expect(
      errorText(
        await alice.call('insert_row', {
          table: 'tasks',
          row: { project_id: Number(bobProject), title: 'mcp-test' },
        }),
      ),
    ).toMatch(/42501/);
  });

  it('anon has no insert grant at all', async () => {
    expect(
      errorText(
        await anon.call('insert_row', { table: 'projects', row: { name: 'mcp-test-anon' } }),
      ),
    ).toMatch(/42501/);
  });

  it('insert_row is annotated as a write', async () => {
    const t = (await alice.client.listTools()).tools.find((x) => x.name === 'insert_row');
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe('protocol-level errors', () => {
  it('an unknown tool is a JSON-RPC error (-32602), not a tool result', async () => {
    const s = await connect();
    await expect(s.client.callTool({ name: 'drop_database', arguments: {} })).rejects.toMatchObject(
      { code: -32602 },
    );
    await s.close();
  });

  it('unexpected argument names are rejected as a tool error the model can read', async () => {
    const s = await connect();
    const r = await s.call('count_rows', { table: 'tasks', where: '1=1' });
    expect(errorText(r)).toMatch(/Invalid arguments for count_rows/);
    await s.close();
  });
});
