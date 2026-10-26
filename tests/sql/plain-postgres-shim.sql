-- Only for running the tests against plain Postgres (no Supabase): creates the anon and
-- authenticated roles and an auth.uid() that reads the same claims Supabase/PostgREST set.
-- A real Supabase database already has all of this.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
