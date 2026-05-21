create table enrollments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  program_id uuid not null references programs(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null check (status in ('registered', 'cancelled', 'waitlisted')),
  enrolled_at timestamptz,
  platform_enrollment_id text,
  raw_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, program_id)
);

create index enrollments_contact_id_idx on enrollments(contact_id);
create index enrollments_program_id_idx on enrollments(program_id);
create index enrollments_client_id_idx on enrollments(client_id);
create index enrollments_status_idx on enrollments(status);
create index enrollments_program_id_status_idx on enrollments(program_id, status);
create unique index enrollments_platform_enrollment_id_key on enrollments(client_id, platform_enrollment_id) where platform_enrollment_id is not null;

create or replace function update_enrollments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger enrollments_updated_at
  before update on enrollments
  for each row execute function update_enrollments_updated_at();

alter table enrollments enable row level security;

create policy "select_policy" on enrollments
  for select using (can_access_client(client_id));

create policy "insert_policy" on enrollments
  for insert with check (can_access_client(client_id));

create policy "update_policy" on enrollments
  for update using (can_access_client(client_id));

create policy "delete_policy" on enrollments
  for delete using (can_access_client(client_id));
