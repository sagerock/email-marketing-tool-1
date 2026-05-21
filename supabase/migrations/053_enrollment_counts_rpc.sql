-- 053_enrollment_counts_rpc.sql
create or replace function get_program_enrollment_counts(
  p_client_id uuid,
  p_year int
)
returns table(
  name text,
  format text,
  count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select p.name, p.format, count(e.id)::bigint
  from programs p
  left join enrollments e
    on e.program_id = p.id and e.status = 'registered'
  where p.client_id = p_client_id
    and p.year = p_year
  group by p.name, p.format
  order by p.name, p.format
$$;

grant execute on function get_program_enrollment_counts(uuid, int) to authenticated, service_role;
