BEGIN;

REVOKE ALL ON FUNCTION public.autoforge_bootstrap_super_admin(varchar, varchar, boolean) FROM service_role;
REVOKE ALL ON FUNCTION public.autoforge_backfill_user_roles(boolean) FROM service_role;
REVOKE ALL ON FUNCTION public.autoforge_update_user_role(varchar, varchar, varchar, varchar, integer) FROM service_role;
REVOKE ALL ON FUNCTION public.autoforge_list_users(varchar, integer, integer, text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.autoforge_ensure_my_role(varchar) FROM service_role;

DROP FUNCTION IF EXISTS public.autoforge_bootstrap_super_admin(varchar, varchar, boolean);
DROP FUNCTION IF EXISTS public.autoforge_backfill_user_roles(boolean);
DROP FUNCTION IF EXISTS public.autoforge_update_user_role(varchar, varchar, varchar, varchar, integer);
DROP FUNCTION IF EXISTS public.autoforge_list_users(varchar, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.autoforge_ensure_my_role(varchar);
DROP FUNCTION IF EXISTS public.autoforge_require_manage_users(varchar);
DROP FUNCTION IF EXISTS public.autoforge_mask_phone(text);
DROP FUNCTION IF EXISTS public.autoforge_mask_email(text);

-- Deliberately preserve app_user_roles and app_user_role_audit for recovery/audit.
COMMIT;
