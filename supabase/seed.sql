-- Fixed ids so tests can act as either user. These are not auth.users rows; the server only
-- needs the uuid that auth.uid() returns.
-- alice = 11111111-1111-4111-8111-111111111111, bob = 22222222-2222-4222-8222-222222222222
insert into public.projects (name, is_public, owner_id)
values
  ('Open roadmap', true, '11111111-1111-4111-8111-111111111111'),
  ('Alice private', false, '11111111-1111-4111-8111-111111111111'),
  ('Bob private', false, '22222222-2222-4222-8222-222222222222');

insert into public.tasks (project_id, title, done, owner_id)
select p.id, t.title, t.done, p.owner_id
from public.projects p
join (values
  ('Open roadmap', 'Publish changelog', true),
  ('Open roadmap', 'Write migration guide', false),
  ('Alice private', 'Renew domain', false),
  ('Alice private', 'Rotate API keys', false),
  ('Bob private', 'Plan offsite', false)
) as t(project, title, done) on t.project = p.name;

insert into public.internal_notes (body) values ('not for API roles');
