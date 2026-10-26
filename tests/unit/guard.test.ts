import { describe, expect, it } from 'vitest';
import { assertSelectOnly, stripLiteralsAndComments } from '../../src/guard.ts';

describe('assertSelectOnly', () => {
  it.each([
    'select 1',
    'SELECT * FROM public.tasks WHERE title = $$drop table x; $$',
    "with t as (select 'a;b' as v) select * from t;",
    'select "insert" from (select 1 as "insert") s -- delete everything',
    'values (1), (2)',
    'table public.projects',
  ])('allows %s', (sql) => {
    expect(() => assertSelectOnly(sql)).not.toThrow();
  });

  it.each([
    ['select 1; delete from tasks', /single statement/],
    ['delete from tasks', /only SELECT/],
    ['with d as (delete from tasks returning *) select * from d', /DELETE/],
    ['select * into new_table from tasks', /INTO/],
    ['explain analyze select 1', /only SELECT/],
    ['select set_config($$x$$, $$y$$, false); select 1', /single statement/],
    ['select 1 /* unterminated', /unterminated/],
    ["select 'unterminated", /unterminated/],
    ['', /empty/],
    ['   ;  ', /empty/],
  ])('rejects %s', (sql, msg) => {
    expect(() => assertSelectOnly(sql)).toThrow(msg);
  });

  it('strips a trailing semicolon from the statement it returns', () => {
    expect(assertSelectOnly('select 1 ;  ')).toBe('select 1');
  });
});

describe('stripLiteralsAndComments', () => {
  it('blanks out literals, quoted identifiers, dollar quotes and comments', () => {
    const s = stripLiteralsAndComments(`select 'it''s;', "a;b", $tag$;$tag$ -- ;\n/* ; */ 1`);
    expect(s).not.toContain(';');
  });
});
