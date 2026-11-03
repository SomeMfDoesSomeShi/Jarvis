create table if not exists public.jarvis_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  files jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.jarvis_projects enable row level security;

create policy "Users can view their own JARVIS projects"
on public.jarvis_projects
for select to authenticated
using (auth.uid() = user_id);

create policy "Users can create their own JARVIS projects"
on public.jarvis_projects
for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own JARVIS projects"
on public.jarvis_projects
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own JARVIS projects"
on public.jarvis_projects
for delete to authenticated
using (auth.uid() = user_id);

create index if not exists jarvis_projects_user_updated_idx
on public.jarvis_projects (user_id, updated_at desc);