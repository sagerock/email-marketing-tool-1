-- Fix programs: unique constraint (add platform to prevent false conflicts across platforms)
alter table programs drop constraint programs_client_id_platform_id_key;
alter table programs add constraint programs_client_id_platform_platform_id_key unique (client_id, platform, platform_id);

-- Fix programs: indexes (replace two single-column indexes with one composite)
drop index if exists programs_client_id_idx;
drop index if exists programs_year_idx;
create index programs_client_id_year_idx on programs(client_id, year);

-- Fix programs: RLS (replace broken FOR ALL subselect with 4 proper can_access_client policies)
drop policy if exists "client_isolation" on programs;
create policy "select_policy" on programs for select using (can_access_client(client_id));
create policy "insert_policy" on programs for insert with check (can_access_client(client_id));
create policy "update_policy" on programs for update using (can_access_client(client_id));
create policy "delete_policy" on programs for delete using (can_access_client(client_id));

-- Fix enrollments: additional indexes
create index enrollments_program_id_status_idx on enrollments(program_id, status);
create unique index enrollments_platform_enrollment_id_key on enrollments(client_id, platform_enrollment_id) where platform_enrollment_id is not null;

-- Fix enrollments: RLS (replace broken FOR ALL subselect with 4 proper can_access_client policies)
drop policy if exists "client_isolation" on enrollments;
create policy "select_policy" on enrollments for select using (can_access_client(client_id));
create policy "insert_policy" on enrollments for insert with check (can_access_client(client_id));
create policy "update_policy" on enrollments for update using (can_access_client(client_id));
create policy "delete_policy" on enrollments for delete using (can_access_client(client_id));
