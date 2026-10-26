// Builds parameterised SQL from validated, structured input. Identifiers are only ever taken
// from the live catalog (see describeTable) and are always double-quoted; values are always
// bound parameters. Nothing a client sends is concatenated into SQL as text.

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'in',
  'is_null',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type Scalar = string | number | boolean | null;

export interface Filter {
  column: string;
  op: FilterOp;
  value?: Scalar | Scalar[];
}

export interface OrderBy {
  column: string;
  direction?: 'asc' | 'desc';
}

export interface SelectSpec {
  schema: string;
  table: string;
  columns?: string[];
  filters?: Filter[];
  orderBy?: OrderBy[];
  limit: number;
  offset?: number;
}

export function quoteIdent(name: string): string {
  if (name.length === 0 || name.length > 63 || name.includes('\0')) {
    throw new Error(`invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

const OP_SQL: Record<Exclude<FilterOp, 'in' | 'is_null'>, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

/** Throws if any referenced column is not one of the table's known columns. */
export function assertKnownColumns(spec: SelectSpec, known: ReadonlySet<string>): void {
  const used = [
    ...(spec.columns ?? []),
    ...(spec.filters ?? []).map((f) => f.column),
    ...(spec.orderBy ?? []).map((o) => o.column),
  ];
  const unknown = used.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new Error(`unknown column(s) on ${spec.schema}.${spec.table}: ${unknown.join(', ')}`);
  }
}

export function buildWhere(filters: Filter[] | undefined, params: unknown[]): string {
  if (!filters || filters.length === 0) return '';
  const parts = filters.map((f) => {
    const col = quoteIdent(f.column);
    if (f.op === 'is_null') {
      if (f.value !== undefined && typeof f.value !== 'boolean') {
        throw new Error('is_null takes an optional boolean value');
      }
      return f.value === false ? `${col} IS NOT NULL` : `${col} IS NULL`;
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        throw new Error(`"in" on ${f.column} needs a non-empty array`);
      }
      params.push(f.value);
      return `${col} = ANY($${params.length})`;
    }
    if (f.value === undefined || f.value === null || Array.isArray(f.value)) {
      throw new Error(`"${f.op}" on ${f.column} needs a single non-null value`);
    }
    params.push(f.value);
    return `${col} ${OP_SQL[f.op]} $${params.length}`;
  });
  return ` WHERE ${parts.join(' AND ')}`;
}

export function buildSelect(spec: SelectSpec): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const cols =
    spec.columns && spec.columns.length > 0 ? spec.columns.map(quoteIdent).join(', ') : '*';
  let text = `SELECT ${cols} FROM ${quoteIdent(spec.schema)}.${quoteIdent(spec.table)}`;
  text += buildWhere(spec.filters, values);
  if (spec.orderBy && spec.orderBy.length > 0) {
    text +=
      ' ORDER BY ' +
      spec.orderBy
        .map((o) => `${quoteIdent(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ');
  }
  values.push(spec.limit);
  text += ` LIMIT $${values.length}`;
  if (spec.offset) {
    values.push(spec.offset);
    text += ` OFFSET $${values.length}`;
  }
  return { text, values };
}

export function buildCount(spec: Omit<SelectSpec, 'limit'>): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text =
    `SELECT count(*)::bigint AS count FROM ${quoteIdent(spec.schema)}.${quoteIdent(spec.table)}` +
    buildWhere(spec.filters, values);
  return { text, values };
}

export function buildInsert(
  schema: string,
  table: string,
  row: Record<string, Scalar>,
): { text: string; values: unknown[] } {
  const cols = Object.keys(row);
  if (cols.length === 0) throw new Error('row must have at least one column');
  const values = cols.map((c) => row[c]);
  const text =
    `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) ` +
    `VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
  return { text, values };
}
