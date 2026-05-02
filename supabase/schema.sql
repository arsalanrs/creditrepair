-- Run in Supabase SQL Editor (Dashboard → SQL → New query).
-- Creates `intake_submissions` (legacy) and `jobs` (saved preview/submit AI runs) + RLS tied to auth.users.

create table if not exists public.intake_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preview', 'submit')),
  form_data jsonb not null default '{}'::jsonb,
  ai_analysis text,
  created_at timestamptz not null default now()
);

create index if not exists intake_submissions_user_created_idx
  on public.intake_submissions (user_id, created_at desc);

alter table public.intake_submissions enable row level security;

drop policy if exists "Users select own submissions" on public.intake_submissions;
create policy "Users select own submissions"
  on public.intake_submissions for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own submissions" on public.intake_submissions;
create policy "Users insert own submissions"
  on public.intake_submissions for insert
  with check (auth.uid() = user_id);

-- Optional: allow users to delete their own rows (uncomment if needed)
-- drop policy if exists "Users delete own submissions" on public.intake_submissions;
-- create policy "Users delete own submissions"
--   on public.intake_submissions for delete
--   using (auth.uid() = user_id);

-- Saved AI runs (preview + submit). The app writes here so users can reopen analysis later.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preview', 'submit')),
  borrower_name text,
  form_data jsonb not null default '{}'::jsonb,
  ai_analysis text,
  created_at timestamptz not null default now()
);

create index if not exists jobs_user_created_idx
  on public.jobs (user_id, created_at desc);

alter table public.jobs enable row level security;

drop policy if exists "Users select own jobs" on public.jobs;
create policy "Users select own jobs"
  on public.jobs for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own jobs" on public.jobs;
create policy "Users insert own jobs"
  on public.jobs for insert
  with check (auth.uid() = user_id);
