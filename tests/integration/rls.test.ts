import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE, BOB, connect, data, ensureSchema, errorText } from './helpers.ts';

type Rows = { rowCount: number; rows: Array<Record<string, unknown>> };
const names = (r: Rows) => r.rows.map((x) => x.name).sort();

beforeAll(ensureSchema);

describe('row-level security is applied to every read', () => {
  let anon: Awaited<ReturnType<typeof connect>>;
  let alice: Awaited<ReturnType<typeof connect>>;
  let bob: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    anon = await connect();
    alice = await connect({ MCP_DB_ROLE: 'authenticated', MCP_USER_ID: ALICE });
    bob = await connect({ MCP_DB_ROLE: 'authenticated', MCP_USER_ID: BOB });
  });
  afterAll(async () => {
    await Promise.all([anon.close(), alice.close(), bob.close()]);
  });

  it('whoami reports the database role and auth.uid() the queries actually run with', async () => {
    expect(data(await anon.call('whoami'))).toMatchObject({
      databaseRole: 'anon',
      userId: null,
      writesEnabled: false,
    });
    expect(data(await alice.call('whoami'))).toMatchObject({
      databaseRole: 'authenticated',
      userId: ALICE,
    });
  });

  it('anon sees only public projects', async () => {
    const r = data<Rows>(await anon.call('select_rows', { table: 'projects', columns: ['name'] }));
    expect(names(r).filter((n) => !String(n).startsWith('mcp-test'))).toEqual(['Open roadmap']);
  });

  it("each user sees public projects plus their own, never the other user's", async () => {
    const a = names(
      data<Rows>(await alice.call('select_rows', { table: 'projects', columns: ['name'] })),
    );
    const b = names(
      data<Rows>(await bob.call('select_rows', { table: 'projects', columns: ['name'] })),
    );
    expect(a).toContain('Alice private');
    expect(a).not.toContain('Bob private');
    expect(b).toContain('Bob private');
    expect(b).not.toContain('Alice private');
  });

  it("filtering for another user's rows returns nothing rather than an error", async () => {
    const r = data<Rows>(
      await alice.call('select_rows', {
        table: 'projects',
        filters: [{ column: 'owner_id', op: 'eq', value: BOB }],
      }),
    );
    expect(r.rows.filter((x) => !x.is_public)).toEqual([]);
  });

  it("tasks follow their project's visibility, and counts agree with selects", async () => {
    const anonTasks = data<Rows>(
      await anon.call('select_rows', { table: 'tasks', columns: ['title'] }),
    );
    const titles = anonTasks.rows.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining(['Publish changelog', 'Write migration guide']));
    expect(titles).not.toContain('Renew domain');
    expect(titles).not.toContain('Plan offsite');
    const count = data<{ count: number }>(await anon.call('count_rows', { table: 'tasks' })).count;
    expect(count).toBe(anonTasks.rowCount);
    const aliceOpen = data<{ count: number }>(
      await alice.call('count_rows', {
        table: 'tasks',
        filters: [{ column: 'done', op: 'eq', value: false }],
      }),
    ).count;
    expect(aliceOpen).toBeGreaterThanOrEqual(3);
  });

  it('a table without grants for API roles is invisible to list, describe and select', async () => {
    const tables = data<{ tables: Array<{ name: string; rls_enabled: boolean }> }>(
      await alice.call('list_tables'),
    );
    const listed = tables.tables.map((t) => t.name);
    expect(listed).toEqual(expect.arrayContaining(['projects', 'tasks']));
    expect(listed).not.toContain('internal_notes');
    expect(tables.tables.find((t) => t.name === 'projects')?.rls_enabled).toBe(true);
    expect(errorText(await alice.call('describe_table', { table: 'internal_notes' }))).toMatch(
      /not visible/,
    );
    expect(errorText(await alice.call('select_rows', { table: 'internal_notes' }))).toMatch(
      /not visible/,
    );
  });

  it('describe_table shows columns, the RLS flag and policy names', async () => {
    const d = data<{
      rlsEnabled: boolean;
      columns: Array<{ name: string }>;
      policies: Array<{ name: string }>;
    }>(await anon.call('describe_table', { table: 'projects' }));
    expect(d.rlsEnabled).toBe(true);
    expect(d.columns.map((c) => c.name)).toEqual([
      'id',
      'name',
      'is_public',
      'owner_id',
      'created_at',
    ]);
    expect(d.policies.map((p) => p.name)).toContain('projects are readable when public or owned');
  });
});
