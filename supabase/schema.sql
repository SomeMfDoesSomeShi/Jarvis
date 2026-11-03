create extension if not exists pgcrypto;
create table if not exists public.jarvis_projects (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null,
 kind text not null default 'web' check (kind in ('web','vr')),
 files jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.jarvis_projects enable row level security;
create policy "Users read own projects" on public.jarvis_projects for select to authenticated using (auth.uid()=user_id);
create policy "Users insert own projects" on public.jarvis_projects for insert to authenticated with check (auth.uid()=user_id);
create policy "Users update own projects" on public.jarvis_projects for update to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "Users delete own projects" on public.jarvis_projects for delete to authenticated using (auth.uid()=user_id);
