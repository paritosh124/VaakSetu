-- VaakSetu initial schema.
-- Multi-tenant: every user belongs to an org. Usage is logged per event
-- (one row per external AI API call) with an org-level RLS scope.
-- Invite-only: a new auth.users row only gets a corresponding profile if
-- an `invitations` row for that email already exists.

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table orgs (
  id                  uuid         primary key default gen_random_uuid(),
  name                text         not null,
  plan                text         not null default 'trial',
  monthly_minute_cap  int          not null default 120,
  created_at          timestamptz  not null default now()
);

-- `profiles` extends Supabase's auth.users with our own fields.
-- auth.users stays owned by Supabase (email, password hash, OAuth identity);
-- our profile holds the org_id + role that drive RLS and features.
create table profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  org_id      uuid        not null references orgs(id) on delete cascade,
  email       text        not null unique,
  role        text        not null default 'agent' check (role in ('admin', 'agent')),
  created_at  timestamptz not null default now()
);

create table invitations (
  id           uuid         primary key default gen_random_uuid(),
  email        text         not null unique,
  org_id       uuid         not null references orgs(id) on delete cascade,
  role         text         not null default 'agent' check (role in ('admin', 'agent')),
  invited_by   uuid         references auth.users(id),
  accepted_at  timestamptz,
  created_at   timestamptz  not null default now()
);

-- One row per external AI API call. Duration/chars/cost are estimates so
-- you can query monthly spend per org without hitting Sarvam's billing API.
create table usage_events (
  id              uuid         primary key default gen_random_uuid(),
  user_id         uuid         not null references auth.users(id),
  org_id          uuid         not null references orgs(id),
  event_type      text         not null,    -- 'stt' | 'translate' | 'tts' | 'stt-stream' | ...
  provider        text,                      -- 'sarvam' | 'groq' | 'elevenlabs' | 'openai'
  source_lang     text,
  target_lang     text,
  chars           int,
  duration_ms     int,
  api_cost_cents  int,                       -- estimated at insertion time
  metadata        jsonb,
  created_at      timestamptz  not null default now()
);

create index usage_events_org_created_idx  on usage_events (org_id, created_at desc);
create index usage_events_user_created_idx on usage_events (user_id, created_at desc);

-- ─── Row-level security ─────────────────────────────────────────────────────

alter table orgs          enable row level security;
alter table profiles      enable row level security;
alter table invitations   enable row level security;
alter table usage_events  enable row level security;

-- Helper: the current user's org_id + role. Marked stable so PG can cache it
-- per-statement inside RLS policies.
create or replace function current_profile()
returns table (org_id uuid, role text)
language sql stable security definer as $$
  select org_id, role from profiles where id = auth.uid()
$$;

-- Users can read their own org record.
create policy "orgs: members see their org" on orgs
  for select using (id = (select org_id from current_profile()));

-- Users can read profiles within their org.
create policy "profiles: members see own org" on profiles
  for select using (org_id = (select org_id from current_profile()));

-- Agents see their own usage; admins see the whole org's usage.
create policy "usage: own rows" on usage_events
  for select using (user_id = auth.uid());
create policy "usage: admins see org" on usage_events
  for select using (
    org_id = (select org_id from current_profile())
    and (select role from current_profile()) = 'admin'
  );

-- Only org admins list/manage invitations for their org.
create policy "invitations: admins see org" on invitations
  for select using (
    org_id = (select org_id from current_profile())
    and (select role from current_profile()) = 'admin'
  );
create policy "invitations: admins insert for org" on invitations
  for insert with check (
    org_id = (select org_id from current_profile())
    and (select role from current_profile()) = 'admin'
  );

-- ─── Invite-only sign-up trigger ────────────────────────────────────────────
-- When Supabase creates a new auth.users row (via OAuth / magic link),
-- check the invitations table. If no invite exists for that email, raise
-- an exception so the signup rolls back — the user can't log in.

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  invite_record record;
begin
  select * into invite_record
    from invitations
    where lower(email) = lower(new.email)
      and accepted_at is null
    limit 1;

  if invite_record is null then
    raise exception 'Email % is not invited. Ask your admin for access.', new.email
      using errcode = '42501';
  end if;

  insert into profiles (id, org_id, email, role)
    values (new.id, invite_record.org_id, new.email, invite_record.role);

  update invitations
    set accepted_at = now()
    where id = invite_record.id;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ─── Seed (safe to re-run — deletes are not automatic) ──────────────────────
-- Creates a test org and pre-invites the developer's email so local testing
-- works the moment `supabase start` is run.

insert into orgs (id, name, plan, monthly_minute_cap)
values ('00000000-0000-0000-0000-000000000001', 'VaakSetu Test Org', 'trial', 1200)
on conflict (id) do nothing;

insert into invitations (email, org_id, role)
values ('paritoshvyas1@gmail.com', '00000000-0000-0000-0000-000000000001', 'admin')
on conflict (email) do nothing;
