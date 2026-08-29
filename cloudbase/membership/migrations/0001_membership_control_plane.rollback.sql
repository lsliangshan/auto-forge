BEGIN;

REVOKE ALL ON FUNCTION public.autoforge_membership_get_current(varchar)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_membership_get_target(varchar, varchar)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_membership_mutate(
  varchar, varchar, varchar, integer, varchar, varchar, timestamptz, varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_membership_list_audit(
  varchar, varchar, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
