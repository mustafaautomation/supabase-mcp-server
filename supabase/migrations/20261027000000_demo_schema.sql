-- Demo schema used by the tests and the README examples.
-- Two users own projects; projects can be public. Tasks inherit visibility from their project.

create table public.projects (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 200),
  is_public boolean not null default false,
  owner_id uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.tasks (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects (id) on delete cascade,
  title text not null check (length(title) between 1 and 500),
  done boolean not null default false,
  owner_id uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

-- Not exposed to API roles at all: used to prove the server cannot see it.
create table public.internal_notes (
  id bigint generated always as identity primary key,
  body text not null
);

create index on public.projects (owner_id);
create index on public.tasks (project_id);

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.internal_notes enable row level security;

-- Supabase grants broad default privileges on new public tables; narrow them explicitly.
revoke all on public.projects, public.tasks, public.internal_notes from anon, authenticated;
grant select on public.projects, public.tasks to anon, authenticated;
grant insert on public.projects, public.tasks to authenticated;

create policy "projects are readable when public or owned"
  on public.projects for select to anon, authenticated
  using (is_public or owner_id = (select auth.uid()));

create policy "users create their own projects"
  on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "tasks are readable when their project is"
  on public.tasks for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.id = project_id));

create policy "users add tasks to their own projects"
  on public.tasks for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid()))
  );
