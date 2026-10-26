// A conservative check for the optional run_select_sql tool. It is one layer of several: the
// statement also runs in a READ ONLY transaction, under the anon/authenticated role (so RLS
// applies), with a statement timeout and a row cap. The guard exists to give a clear error early,
// not to be the thing that keeps the database safe.

/** Replaces string literals, quoted identifiers, dollar-quoted bodies and comments with spaces. */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated quoted string');
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += c === '"' ? ' x ' : " '' ";
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error('unterminated dollar-quoted string');
        out += " '' ";
        i = end + tag.length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const FORBIDDEN =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do|vacuum|analyze|cluster|reindex|refresh|lock|listen|notify|set|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|discard|security|into)\b/i;

export function assertSelectOnly(sql: string): string {
  const stripped = stripLiteralsAndComments(sql).trim();
  const body = stripped.replace(/;\s*$/, '');
  if (body.length === 0) throw new Error('empty statement');
  if (body.includes(';')) throw new Error('only a single statement is allowed');
  if (!/^(select|with|values|table)\b/i.test(body)) {
    throw new Error('only SELECT / WITH / VALUES / TABLE statements are allowed');
  }
  const bad = FORBIDDEN.exec(body);
  if (bad) throw new Error(`keyword not allowed in read-only SQL: ${bad[0].toUpperCase()}`);
  return sql.trim().replace(/;\s*$/, '').trimEnd();
}
