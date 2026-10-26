# supabase-mcp-server

[![CI](https://github.com/mustafaautomation/supabase-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mustafaautomation/supabase-mcp-server/actions/workflows/ci.yml)

A Model Context Protocol (MCP) server that gives Claude (or any MCP client) **read-mostly, row-level-security-aware** access to a Supabase Postgres database. Personal open-source project, built with AI coding agents and tested like a QA engineer would want it tested.

The point of the repo is the safety model and the tests around it, not the number of tools.

## What it does

| Tool | Default | What it does |
|---|---|---|
| `whoami` | on | Role, `auth.uid()`, exposed schemas, row cap, which opt-in tools are enabled. No credentials. |
| `list_tables` | on | Tables/views in the exposed schemas that the role can see, with the RLS flag |
| `describe_table` | on | Columns, RLS flag, RLS policy names and commands |
| `select_rows` | on | Structured select: columns, filters (`eq neq gt gte lt lte like ilike in is_null`), order, limit, offset. No raw SQL |
| `count_rows` | on | Count with the same filters |
| `run_select_sql` | `MCP_ALLOW_SQL=true` | One `SELECT`/`WITH` statement, read-only transaction, timeout, row cap |
| `insert_row` | `MCP_ALLOW_WRITES=true` | Insert one row; RLS insert policies decide |

## Safety model

Every tool call runs in its own transaction that:

1. switches to the Supabase API role with `SET LOCAL ROLE anon | authenticated`, so the connection's own privileges are not used for queries;
2. sets `request.jwt.claims` / `request.jwt.claim.sub` the way PostgREST does, so `auth.uid()` and every RLS policy behave as they would for a supabase-js client signed in as `MCP_USER_ID`;
3. is `READ ONLY` for every tool except `insert_row`;
4. has a `statement_timeout` (`MCP_STATEMENT_TIMEOUT_MS`, default 5000).

On top of that:

- Identifiers must be plain names (validated with zod), are checked against the live catalog as seen by the role, and are always quoted. Values are always bound parameters.
- Only schemas in `MCP_SCHEMAS` can be named. `auth`, `storage` and `pg_catalog` are not reachable by default.
- Results are capped at `MCP_MAX_ROWS` (default 100, max 1000), enforced in the tool's input schema.
- `run_select_sql` has a literal/comment-aware guard (single statement, `SELECT`/`WITH`/`VALUES`/`TABLE` only, no DML/DDL keywords). The guard gives early, clear errors; the read-only transaction and the role are what actually prevent writes.
- Errors are returned as tool results (`isError: true`) with the Postgres code and a short hint (e.g. `42501: permission denied (row-level security or grants)`), so the model can correct itself. Unknown tools are JSON-RPC errors (`-32602`), as the spec requires.
- The server logs only to stderr and never prints the connection string.

What it does **not** do: verify a user's JWT. You choose the role and user id in the server's environment. Treat it as a local developer tool for your own data, not as a multi-user gateway. Never point it at a connection that uses `service_role`.

## Protocol version

Built on the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2), which negotiates MCP **2025-11-25**. The spec has a newer revision (2026-07-28); the server will move to it when the SDK does. The low-level `Server` API is used so error handling follows the spec exactly (see above).

## Quick start (local Supabase)

Needs Node 22+ (24 recommended), Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
git clone https://github.com/mustafaautomation/supabase-mcp-server.git
cd supabase-mcp-server
npm ci && npm run build
supabase db start          # Postgres on 54322, applies supabase/migrations and supabase/seed.sql
```

The demo schema has `projects` (public or private, owned by a user) and `tasks` (visible when their project is), plus an `internal_notes` table with no grants for API roles. The seed uses two fixed user ids: alice `11111111-1111-4111-8111-111111111111` and bob `22222222-2222-4222-8222-222222222222`.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), using the absolute path to your clone:

```json
{
  "mcpServers": {
    "supabase-local": {
      "command": "node",
      "args": ["/absolute/path/to/supabase-mcp-server/dist/src/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "MCP_DB_ROLE": "authenticated",
        "MCP_USER_ID": "11111111-1111-4111-8111-111111111111"
      }
    }
  }
}
```

Restart Claude Desktop, then ask e.g. "Which of my projects have open tasks?".

### Claude Code

```bash
claude mcp add supabase-local \
  --env DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --env MCP_DB_ROLE=anon \
  -- node "$PWD/dist/src/index.js"
claude mcp list
```

Add `--scope project` to write a shareable `.mcp.json` instead (keep real connection strings out of it).

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector --cli -e DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  --method tools/list -- node dist/src/index.js
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | required | A role that can `SET ROLE anon` and `SET ROLE authenticated` (the local `postgres` user can) |
| `MCP_DB_ROLE` | `anon` | `anon` or `authenticated` |
| `MCP_USER_ID` | none | uuid returned by `auth.uid()`; required for `authenticated`, rejected for `anon` |
| `MCP_SCHEMAS` | `public` | Comma-separated allowlist |
| `MCP_MAX_ROWS` | `100` | 1–1000 |
| `MCP_STATEMENT_TIMEOUT_MS` | `5000` | 100–60000 |
| `MCP_ALLOW_SQL` | `false` | Registers `run_select_sql` |
| `MCP_ALLOW_WRITES` | `false` | Registers `insert_row` |

Invalid configuration stops the server at startup with exit code 2 and a message naming the variable.

## Tests

| Layer | Where | What it covers |
|---|---|---|
| Unit | `tests/unit` | Config parsing, SQL builder (parameters, quoting), the SQL guard (comments, literals, dollar quotes, multi-statement), error mapping |
| Integration | `tests/integration` | Through a real MCP client (in-memory transport) against Postgres: anon vs alice vs bob visibility, tasks inheriting project RLS, invisible ungranted table, unknown columns and schemas, injection strings as data, row cap, read-only transaction, statement timeout, RLS blocking spoofed inserts, opt-in tools hidden by default, protocol errors |
| stdio e2e | `tests/e2e` | The built server as a child process, the way Claude starts it: handshake, tool list, a real query, bad arguments, unknown tool, stderr-only logging, exit code 2 on bad config |
| Inspector | CI | `@modelcontextprotocol/inspector --cli` lists 5 tools and runs `count_rows` |
| Conformance | CI | [mcp-conformance-tests](https://github.com/mustafaautomation/mcp-conformance-tests) (pinned) must pass all MUST checks |

I checked that the RLS tests catch a real regression: with the `SET LOCAL ROLE` line removed, the visibility and insert-policy tests fail.

```bash
npm test                                   # unit, no database
supabase db start
npm run build && npm run test:integration && npm run test:e2e
DATABASE_URL=postgresql://... npm run test:integration   # any Postgres 15+; a shim adds roles and auth.uid()
```

## CI

`.github/workflows/ci.yml`; every job must pass:

- **checks**: ESLint, Prettier, `tsc`, unit tests, build
- **supabase**: Supabase CLI 2.122 `supabase db start`, integration and stdio tests, Inspector CLI smoke test, conformance run
- **plain-postgres**: the same integration and stdio tests against a `postgres:17` service with the shim in `tests/sql`
- **secrets**: gitleaks over the full git history

## License

MIT
