BEGIN;

CREATE OR REPLACE FUNCTION public.autoforge_ensure_my_role(p_caller_user_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  role_row public.app_user_roles%ROWTYPE;
  auth_user_id bigint;
BEGIN
  IF p_caller_user_id IS NULL OR p_caller_user_id = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001';
  END IF;
  SELECT users.id INTO auth_user_id
  FROM auth.users users
  WHERE users.id::text = p_caller_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.app_user_roles(user_id, role, version)
  VALUES (auth_user_id, 'user', 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO STRICT role_row
  FROM public.app_user_roles roles
  WHERE roles.user_id = auth_user_id;

  RETURN jsonb_build_object(
    'userId', role_row.user_id::text,
    'role', role_row.role,
    'capabilities', CASE
      WHEN role_row.role = 'super_admin' THEN jsonb_build_array('manage_users')
      ELSE '[]'::jsonb
    END,
    'version', role_row.version,
    'updatedAt', to_char(role_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

ALTER TABLE public.app_user_roles
  DROP CONSTRAINT IF EXISTS app_user_roles_knowledge_entitlement_check;
ALTER TABLE public.app_user_roles
  DROP COLUMN IF EXISTS knowledge_entitlement;

COMMIT;
