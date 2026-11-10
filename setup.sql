-- Plan: run once in Supabase → SQL Editor (the same project Pocket uses is fine; these tables don't touch Pocket's).

-- Each block on your schedule.
create table if not exists public.plan_tasks (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  title        text        not null check (char_length(title) between 1 and 200),
  notes        text        not null default '' check (char_length(notes) <= 2000),
  day          date,                                    -- null = not on a day yet ("Someday" list)
  start_time   time,                                    -- null = anytime that day
  duration_min integer     not null default 30 check (duration_min between 5 and 1440),
  kind         text        not null default 'flexible' check (kind in ('fixed', 'flexible')),
  priority     smallint    not null default 2 check (priority between 1 and 3),  -- 1 low, 2 normal, 3 high
  due          date,
  done         boolean     not null default false,
  done_at      timestamptz,
  source       text        not null default 'app' check (source in ('app', 'claude')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists plan_tasks_user_day on public.plan_tasks (user_id, day);

-- Your planning preferences (Claude reads these before it schedules anything).
create table if not exists public.plan_profile (
  user_id     uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone    text        not null default 'America/Los_Angeles',
  day_start   time        not null default '08:00',
  day_end     time        not null default '23:00',
  focus_hours text        not null default '' check (char_length(focus_hours) <= 200),
  notes       text        not null default '' check (char_length(notes) <= 2000),
  updated_at  timestamptz not null default now()
);

-- Every change Claude makes, with the task before and after, so the app can undo it.
create table if not exists public.plan_changes (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  task_id    uuid        not null,
  action     text        not null check (action in ('add', 'update', 'delete')),
  before     jsonb,
  after      jsonb,
  summary    text        not null default '',
  undone     boolean     not null default false,
  created_at timestamptz not null default now()
);
create index if not exists plan_changes_user_time on public.plan_changes (user_id, created_at desc);

-- The connector link for the Claude app. Only a SHA-256 hash of the secret is stored.
create table if not exists public.plan_connector (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  token_hash text        not null unique,
  created_at timestamptz not null default now()
);

-- Keep updated_at current.
create or replace function public.plan_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists plan_tasks_touch on public.plan_tasks;
create trigger plan_tasks_touch before update on public.plan_tasks for each row execute function public.plan_touch();
drop trigger if exists plan_profile_touch on public.plan_profile;
create trigger plan_profile_touch before update on public.plan_profile for each row execute function public.plan_touch();

-- Only the signed-in owner can read or change their rows. (The connector runs on the server and checks the link itself.)
alter table public.plan_tasks     enable row level security;
alter table public.plan_profile   enable row level security;
alter table public.plan_changes   enable row level security;
alter table public.plan_connector enable row level security;

drop policy if exists "Own rows only" on public.plan_tasks;
create policy "Own rows only" on public.plan_tasks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.plan_profile;
create policy "Own rows only" on public.plan_profile for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.plan_changes;
create policy "Own rows only" on public.plan_changes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own rows only" on public.plan_connector;
create policy "Own rows only" on public.plan_connector for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Live updates, so changes Claude makes show up in the open app right away.
do $$ begin
  begin alter publication supabase_realtime add table public.plan_tasks;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.plan_changes; exception when duplicate_object then null; end;
end $$;
