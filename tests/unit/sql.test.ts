import { describe, expect, it } from 'vitest';
import {
  assertKnownColumns,
  buildCount,
  buildInsert,
  buildSelect,
  quoteIdent,
} from '../../src/sql.ts';

describe('quoteIdent', () => {
  it('double-quotes and escapes embedded quotes', () => {
    expect(quoteIdent('tasks')).toBe('"tasks"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
  it('rejects empty, overlong and NUL-containing names', () => {
    expect(() => quoteIdent('')).toThrow();
    expect(() => quoteIdent('x'.repeat(64))).toThrow();
    expect(() => quoteIdent('a\0b')).toThrow();
  });
});

describe('buildSelect', () => {
  it('binds every value as a parameter, including the limit', () => {
    const q = buildSelect({
      schema: 'public',
      table: 'tasks',
      columns: ['id', 'title'],
      filters: [
        { column: 'done', op: 'eq', value: false },
        { column: 'title', op: 'ilike', value: "%'; drop table tasks; --%" },
        { column: 'id', op: 'in', value: [1, 2] },
        { column: 'owner_id', op: 'is_null', value: false },
      ],
      orderBy: [{ column: 'id', direction: 'desc' }],
      limit: 10,
      offset: 5,
    });
    expect(q.text).toBe(
      'SELECT "id", "title" FROM "public"."tasks" WHERE "done" = $1 AND "title" ILIKE $2 AND "id" = ANY($3) AND "owner_id" IS NOT NULL ORDER BY "id" DESC LIMIT $4 OFFSET $5',
    );
    expect(q.values).toEqual([false, "%'; drop table tasks; --%", [1, 2], 10, 5]);
  });

  it('selects * when no columns are given', () => {
    expect(buildSelect({ schema: 'public', table: 'projects', limit: 1 }).text).toBe(
      'SELECT * FROM "public"."projects" LIMIT $1',
    );
  });

  it('rejects malformed filters', () => {
    const base = { schema: 'public', table: 't', limit: 1 };
    expect(() => buildSelect({ ...base, filters: [{ column: 'a', op: 'in', value: [] }] })).toThrow(
      /non-empty/,
    );
    expect(() => buildSelect({ ...base, filters: [{ column: 'a', op: 'eq' }] })).toThrow(
      /single non-null/,
    );
    expect(() =>
      buildSelect({ ...base, filters: [{ column: 'a', op: 'eq', value: null }] }),
    ).toThrow();
    expect(() =>
      buildSelect({ ...base, filters: [{ column: 'a', op: 'gt', value: [1] }] }),
    ).toThrow();
    expect(() =>
      buildSelect({ ...base, filters: [{ column: 'a', op: 'is_null', value: 'x' }] }),
    ).toThrow();
  });
});

describe('assertKnownColumns', () => {
  const known = new Set(['id', 'title']);
  it('accepts known columns everywhere and names the unknown ones', () => {
    expect(() =>
      assertKnownColumns(
        { schema: 'public', table: 't', limit: 1, columns: ['id'], orderBy: [{ column: 'title' }] },
        known,
      ),
    ).not.toThrow();
    expect(() =>
      assertKnownColumns(
        {
          schema: 'public',
          table: 't',
          limit: 1,
          filters: [{ column: 'secret', op: 'eq', value: 1 }],
        },
        known,
      ),
    ).toThrow(/unknown column\(s\) on public\.t: secret/);
  });
});

describe('buildCount and buildInsert', () => {
  it('builds a parameterised count', () => {
    expect(
      buildCount({
        schema: 'public',
        table: 'tasks',
        filters: [{ column: 'done', op: 'eq', value: true }],
      }),
    ).toEqual({
      text: 'SELECT count(*)::bigint AS count FROM "public"."tasks" WHERE "done" = $1',
      values: [true],
    });
  });
  it('builds a parameterised insert returning the row', () => {
    expect(buildInsert('public', 'projects', { name: 'x', is_public: false })).toEqual({
      text: 'INSERT INTO "public"."projects" ("name", "is_public") VALUES ($1, $2) RETURNING *',
      values: ['x', false],
    });
    expect(() => buildInsert('public', 'projects', {})).toThrow();
  });
});
