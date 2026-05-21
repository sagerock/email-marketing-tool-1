create table programs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  year int not null,
  format text not null check (format in ('online', 'in-person', 'hybrid')),
  platform text not null check (platform in ('cvent', 'gravity_forms', 'thinkific', 'manual')),
  platform_id text not null,
  tag text not null,
  instructor text,
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform_id)
);

create index programs_client_id_idx on programs(client_id);
create index programs_year_idx on programs(year);

create or replace function update_programs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger programs_updated_at
  before update on programs
  for each row execute function update_programs_updated_at();

alter table programs enable row level security;

create policy "client_isolation" on programs
  using (client_id = (
    select client_id from admin_users where user_id = auth.uid()
  ));
