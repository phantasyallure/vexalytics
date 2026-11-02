create table if not exists ig_session (
  id int primary key,
  token text not null,
  ig_id text not null,
  page_name text,
  updated_at timestamptz default now()
);
-- Locked down: only the server's service key can read or write it.
alter table ig_session enable row level security;

-- Added for the Gemini agent: stores the API key + model chosen in Settings.
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
alter table app_settings enable row level security;

-- Team access codes (members sign in with a personal code; stored hashed, revocable)
create table if not exists team_codes (
  id bigint generated always as identity primary key,
  name text not null,
  code_hash text not null unique,
  role text not null default 'viewer',
  active boolean not null default true,
  created_at timestamptz default now(),
  last_used timestamptz
);
alter table team_codes enable row level security;
notify pgrst, 'reload schema';
