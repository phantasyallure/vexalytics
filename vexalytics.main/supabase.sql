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
