BEGIN;

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
    OR (p_filter_field IS NOT NULL AND p_filter_field NOT IN ('keyword', 'username', 'displayName', 'userId', 'email', 'phone'))
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
        OR (
          p_filter_field = 'keyword'
          AND (
            username ILIKE '%' || p_filter_value || '%'
            OR display_name ILIKE '%' || p_filter_value || '%'
            OR user_id ILIKE '%' || p_filter_value || '%'
            OR email ILIKE '%' || p_filter_value || '%'
            OR phone ILIKE '%' || p_filter_value || '%'
          )
        )
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

REVOKE ALL ON FUNCTION public.autoforge_list_users(varchar, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autoforge_list_users(varchar, integer, integer, text, text) TO service_role;

COMMIT;

