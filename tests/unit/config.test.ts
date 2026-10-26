import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('loadConfig', () => {
  it('defaults to the anon role, public schema and read-only tools', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      role: 'anon',
      schemas: ['public'],
      maxRows: 100,
      allowSql: false,
      allowWrites: false,
    });
  });

  it('requires a user id for the authenticated role', () => {
    expect(() => loadConfig({ ...base, MCP_DB_ROLE: 'authenticated' })).toThrow(/MCP_USER_ID/);
    expect(loadConfig({ ...base, MCP_DB_ROLE: 'authenticated', MCP_USER_ID: ALICE }).userId).toBe(
      ALICE,
    );
  });

  it('rejects a user id for anon, a non-uuid id and unknown roles', () => {
    expect(() => loadConfig({ ...base, MCP_USER_ID: ALICE })).toThrow(/must not be set/);
    expect(() =>
      loadConfig({ ...base, MCP_DB_ROLE: 'authenticated', MCP_USER_ID: 'alice' }),
    ).toThrow();
    expect(() => loadConfig({ ...base, MCP_DB_ROLE: 'service_role' })).toThrow(/MCP_DB_ROLE/);
  });

  it('rejects unsafe schema names and out-of-range limits', () => {
    expect(() => loadConfig({ ...base, MCP_SCHEMAS: 'public; drop table x' })).toThrow(/schema/);
    expect(() => loadConfig({ ...base, MCP_MAX_ROWS: '5000' })).toThrow();
    expect(() => loadConfig({ ...base, MCP_STATEMENT_TIMEOUT_MS: '0' })).toThrow();
    expect(loadConfig({ ...base, MCP_SCHEMAS: 'public, app' }).schemas).toEqual(['public', 'app']);
  });

  it('requires DATABASE_URL and parses boolean flags strictly', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(loadConfig({ ...base, MCP_ALLOW_SQL: 'true', MCP_ALLOW_WRITES: '1' })).toMatchObject({
      allowSql: true,
      allowWrites: true,
    });
    expect(() => loadConfig({ ...base, MCP_ALLOW_WRITES: 'yes' })).toThrow();
  });
});
