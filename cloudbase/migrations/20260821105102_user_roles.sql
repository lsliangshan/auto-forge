BEGIN;

CREATE TABLE IF NOT EXISTS public.app_user_roles (
  user_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role varchar(63) NOT NULL DEFAULT 'user'
    CHECK (role ~ '^[a-z][a-z0-9_]{0,62}$'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by varchar(64)
);

ALTER TABLE public.app_user_roles
  ADD COLUMN IF NOT EXISTS knowledge_entitlement jsonb;
ALTER TABLE public.app_user_roles
  DROP CONSTRAINT IF EXISTS app_user_roles_knowledge_entitlement_check;
ALTER TABLE public.app_user_roles
  ADD CONSTRAINT app_user_roles_knowledge_entitlement_check CHECK (
    knowledge_entitlement IS NULL OR (
      jsonb_typeof(knowledge_entitlement) = 'object'
      AND jsonb_object_length(knowledge_entitlement) = 2
      AND jsonb_typeof(knowledge_entitlement->'payload') = 'string'
      AND jsonb_typeof(knowledge_entitlement->'signature') = 'string'
      AND length(knowledge_entitlement->>'payload') BETWEEN 1 AND 8192
      AND length(knowledge_entitlement->>'signature') BETWEEN 1 AND 256
      AND knowledge_entitlement->>'payload' ~ '^[A-Za-z0-9_-]+$'
      AND knowledge_entitlement->>'signature' ~ '^[A-Za-z0-9_-]+$'
    )
  );

CREATE TABLE IF NOT EXISTS public.app_user_role_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id varchar(128) NOT NULL UNIQUE,
  target_user_id varchar(64) NOT NULL,
  old_role varchar(63) NOT NULL CHECK (old_role ~ '^[a-z][a-z0-9_]{0,62}$'),
  new_role varchar(63) NOT NULL CHECK (new_role ~ '^[a-z][a-z0-9_]{0,62}$'),
  operator varchar(64),
  source varchar(32) NOT NULL,
  expected_version integer CHECK (expected_version IS NULL OR expected_version >= 0),
  result_version integer NOT NULL CHECK (result_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_user_roles_role_idx
  ON public.app_user_roles(role);
CREATE INDEX IF NOT EXISTS app_user_role_audit_target_created_idx
  ON public.app_user_role_audit(target_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.autoforge_mask_email(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN position('@' IN p_email) <= 1 THEN '***'
    ELSE left(p_email, 1) || '***' || substring(p_email FROM position('@' IN p_email))
  END
$$;

CREATE OR REPLACE FUNCTION public.autoforge_mask_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN length(p_phone) < 7 THEN '***'
    ELSE left(p_phone, 3) || '****' || right(p_phone, 4)
  END
$$;

CREATE OR REPLACE FUNCTION public.autoforge_require_manage_users(p_caller_user_id varchar)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.app_user_roles roles
    JOIN auth.users users ON users.id = roles.user_id
    WHERE users.id::text = p_caller_user_id
      AND roles.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
END;
$$;

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
    'updatedAt', to_char(role_row.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'knowledgeEntitlement', role_row.knowledge_entitlement
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_list_users(
  p_caller_user_id varchar,
  p_page integer,
  p_page_size integer,
  p_filter_field text DEFAULT NULL,
  p_filter_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM public.autoforge_require_manage_users(p_caller_user_id);
  IF p_page < 1 OR p_page_size NOT IN (20, 50, 100) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF (p_filter_field IS NULL) <> (p_filter_value IS NULL)
    OR (p_filter_field IS NOT NULL AND p_filter_field NOT IN ('username', 'displayName', 'userId', 'email', 'phone'))
    OR (p_filter_value IS NOT NULL AND (btrim(p_filter_value) = '' OR length(p_filter_value) > 254)) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  WITH normalized AS (
    SELECT
      users.id::text AS user_id,
      COALESCE(to_jsonb(users)->>'username', to_jsonb(users)->>'name', users.id::text) AS username,
      COALESCE(to_jsonb(users)->>'nickname', to_jsonb(users)->>'display_name') AS display_name,
      to_jsonb(users)->>'email' AS email,
      COALESCE(to_jsonb(users)->>'phone', to_jsonb(users)->>'phone_number') AS phone,
      COALESCE((to_jsonb(users)->>'blocked')::boolean, false) AS blocked,
      COALESCE((to_jsonb(users)->>'is_anonymous')::boolean, false) AS anonymous,
      COALESCE((to_jsonb(users)->>'created_at')::timestamptz, now()) AS created_at,
      COALESCE(roles.role, 'user') AS role,
      COALESCE(roles.version, 0) AS role_version
    FROM auth.users users
    LEFT JOIN public.app_user_roles roles ON roles.user_id = users.id
  ), filtered AS (
    SELECT *
    FROM normalized
    WHERE NOT anonymous
      AND (
        p_filter_field IS NULL
        OR (p_filter_field = 'userId' AND user_id = p_filter_value)
        OR (p_filter_field = 'email' AND lower(email) = lower(p_filter_value))
        OR (p_filter_field = 'phone' AND phone = p_filter_value)
        OR (p_filter_field = 'username' AND username ILIKE '%' || p_filter_value || '%')
        OR (p_filter_field = 'displayName' AND display_name ILIKE '%' || p_filter_value || '%')
      )
  ), totals AS (
    SELECT count(*) AS total FROM filtered
  ), page_rows AS (
    SELECT * FROM filtered
    ORDER BY created_at DESC, user_id
    LIMIT p_page_size OFFSET ((p_page - 1) * p_page_size)
  )
  SELECT jsonb_build_object(
    'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'userId', user_id,
        'username', username,
        'displayName', display_name,
        'maskedEmail', public.autoforge_mask_email(email),
        'maskedPhone', public.autoforge_mask_phone(phone),
        'status', CASE WHEN blocked THEN 'blocked' ELSE 'active' END,
        'role', role,
        'roleVersion', role_version,
        'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY created_at DESC, user_id), '[]'::jsonb)
      FROM page_rows),
    'page', p_page,
    'pageSize', p_page_size,
    'total', (SELECT total FROM totals)
  ) INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_update_user_role(
  p_caller_user_id varchar,
  p_request_id varchar,
  p_target_user_id varchar,
  p_new_role varchar,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_row public.app_user_role_audit%ROWTYPE;
  old_role varchar(63) := 'user';
  old_version integer := 0;
  next_version integer;
  target_auth_user_id bigint;
  changed_at timestamptz := clock_timestamp();
BEGIN
  PERFORM public.autoforge_require_manage_users(p_caller_user_id);
  IF p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_target_user_id IS NULL OR btrim(p_target_user_id) = '' OR length(p_target_user_id) > 64
    OR p_new_role NOT IN ('user', 'super_admin')
    OR p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_caller_user_id = p_target_user_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_ROLE_CHANGE_FORBIDDEN', ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id, 0));
  SELECT * INTO audit_row
  FROM public.app_user_role_audit audit
  WHERE audit.request_id = p_request_id;
  IF FOUND THEN
    IF audit_row.target_user_id <> p_target_user_id
      OR audit_row.new_role <> p_new_role
      OR audit_row.expected_version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION USING MESSAGE = 'REQUEST_ID_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'userId', audit_row.target_user_id,
      'role', audit_row.new_role,
      'version', audit_row.result_version,
      'updatedAt', to_char(audit_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  END IF;

  SELECT users.id INTO target_auth_user_id
  FROM auth.users users
  WHERE users.id::text = p_target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  SELECT roles.role, roles.version INTO old_role, old_version
  FROM public.app_user_roles roles
  WHERE roles.user_id = target_auth_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    old_role := 'user';
    old_version := 0;
  END IF;
  IF old_version <> p_expected_version THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_CONFLICT', ERRCODE = 'P0001';
  END IF;

  IF old_role = 'super_admin' AND p_new_role <> 'super_admin' THEN
    PERFORM pg_advisory_xact_lock(hashtext('autoforge-super-admin-demotion'));
    IF (
      SELECT count(*)
      FROM public.app_user_roles roles
      JOIN auth.users users ON users.id = roles.user_id
      WHERE roles.role = 'super_admin'
        AND NOT COALESCE((to_jsonb(users)->>'blocked')::boolean, false)
    ) <= 1 THEN
      RAISE EXCEPTION USING MESSAGE = 'LAST_SUPER_ADMIN', ERRCODE = 'P0001';
    END IF;
  END IF;

  next_version := old_version + 1;
  INSERT INTO public.app_user_roles(user_id, role, version, created_at, updated_at, updated_by)
  VALUES (target_auth_user_id, p_new_role, next_version, changed_at, changed_at, p_caller_user_id)
  ON CONFLICT (user_id) DO UPDATE SET
    role = EXCLUDED.role,
    version = EXCLUDED.version,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by;

  INSERT INTO public.app_user_role_audit(
    request_id, target_user_id, old_role, new_role, operator, source,
    expected_version, result_version, created_at
  ) VALUES (
    p_request_id, p_target_user_id, old_role, p_new_role, p_caller_user_id, 'desktop',
    p_expected_version, next_version, changed_at
  );

  RETURN jsonb_build_object(
    'userId', p_target_user_id,
    'role', p_new_role,
    'version', next_version,
    'updatedAt', to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_backfill_user_roles(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  missing_count integer;
  inserted_count integer := 0;
BEGIN
  SELECT count(*) INTO missing_count
  FROM auth.users users
  LEFT JOIN public.app_user_roles roles ON roles.user_id = users.id
  WHERE roles.user_id IS NULL
    AND NOT COALESCE((to_jsonb(users)->>'is_anonymous')::boolean, false);
  IF p_apply THEN
    INSERT INTO public.app_user_roles(user_id, role, version)
    SELECT users.id, 'user', 0
    FROM auth.users users
    LEFT JOIN public.app_user_roles roles ON roles.user_id = users.id
    WHERE roles.user_id IS NULL
      AND NOT COALESCE((to_jsonb(users)->>'is_anonymous')::boolean, false)
    ON CONFLICT (user_id) DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('apply', p_apply, 'missing', missing_count, 'inserted', inserted_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_bootstrap_super_admin(
  p_target_user_id varchar,
  p_request_id varchar,
  p_apply boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_role varchar(63) := 'user';
  current_version integer := 0;
  next_version integer;
  target_auth_user_id bigint;
  changed_at timestamptz := clock_timestamp();
BEGIN
  IF p_target_user_id IS NULL OR btrim(p_target_user_id) = ''
    OR p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT users.id INTO target_auth_user_id
  FROM auth.users users
  WHERE users.id::text = p_target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  SELECT roles.role, roles.version INTO existing_role, current_version
  FROM public.app_user_roles roles WHERE roles.user_id = target_auth_user_id FOR UPDATE;
  IF NOT FOUND THEN existing_role := 'user'; current_version := 0; END IF;
  IF existing_role = 'super_admin' THEN
    RETURN jsonb_build_object('apply', p_apply, 'changed', false, 'userId', p_target_user_id, 'role', existing_role, 'version', current_version);
  END IF;
  IF NOT p_apply THEN
    RETURN jsonb_build_object('apply', false, 'changed', false, 'userId', p_target_user_id, 'fromRole', existing_role, 'toRole', 'super_admin', 'version', current_version);
  END IF;
  next_version := current_version + 1;
  INSERT INTO public.app_user_roles(user_id, role, version, created_at, updated_at, updated_by)
  VALUES (target_auth_user_id, 'super_admin', next_version, changed_at, changed_at, NULL)
  ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin', version = next_version, updated_at = changed_at, updated_by = NULL;
  INSERT INTO public.app_user_role_audit(
    request_id, target_user_id, old_role, new_role, operator, source,
    expected_version, result_version, created_at
  ) VALUES (p_request_id, p_target_user_id, existing_role, 'super_admin', NULL, 'bootstrap', current_version, next_version, changed_at);
  RETURN jsonb_build_object('apply', true, 'changed', true, 'userId', p_target_user_id, 'role', 'super_admin', 'version', next_version);
END;
$$;

REVOKE ALL ON TABLE public.app_user_roles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.app_user_role_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.app_user_role_audit_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_user_roles TO service_role;
GRANT SELECT, INSERT ON TABLE public.app_user_role_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.app_user_role_audit_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.autoforge_mask_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_mask_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_require_manage_users(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_ensure_my_role(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_list_users(varchar, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_update_user_role(varchar, varchar, varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_backfill_user_roles(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_bootstrap_super_admin(varchar, varchar, boolean) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.autoforge_ensure_my_role(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_list_users(varchar, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_update_user_role(varchar, varchar, varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_backfill_user_roles(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_bootstrap_super_admin(varchar, varchar, boolean) TO service_role;

COMMIT;
