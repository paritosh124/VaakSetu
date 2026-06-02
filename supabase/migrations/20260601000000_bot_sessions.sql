-- Meeting Bot session log. One row per call (a LiveKit room the VaakSetu relay
-- joined as translator). Written by the relay server via the service-role key
-- on teardown. RLS mirrors usage_events: agents see their org's rows; admins too.

create table bot_sessions (
  id                uuid         primary key default gen_random_uuid(),
  org_id            uuid         not null references orgs(id) on delete cascade,
  room_name         text,        -- LiveKit room
  source_lang       text,        -- customer language
  target_lang       text,        -- agent language
  started_at        timestamptz  not null default now(),
  ended_at          timestamptz,
  duration_seconds  int,
  transcript        jsonb,       -- [{ ts, who, pivotEn, text }]
  created_at        timestamptz  not null default now()
);

create index bot_sessions_org_created_idx on bot_sessions (org_id, created_at desc);

alter table bot_sessions enable row level security;

-- Members of the org can read its bot sessions.
create policy "bot_sessions: members see own org" on bot_sessions
  for select using (org_id = (select org_id from current_profile()));

-- Note: inserts come from the relay using the service-role key, which bypasses
-- RLS — so no insert policy is needed for the server. (If a client ever needs
-- to insert, add a with-check policy scoped to current_profile().org_id.)
