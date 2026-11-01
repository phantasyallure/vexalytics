create table if not exists ig_session (
  id int primary key,
  token text not null,
  ig_id text not null,
  page_name text,
  updated_at timestamptz default now()
);
-- Locked down: only the server's service key can read or write it.
alter table ig_session enable row level security;
