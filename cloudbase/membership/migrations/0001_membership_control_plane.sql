BEGIN;

CREATE TABLE IF NOT EXISTS public.membership_plans (
  plan_id varchar(32) NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  knowledge_base_limit integer NOT NULL CHECK (knowledge_base_limit > 0),
  knowledge_document_limit integer NOT NULL CHECK (knowledge_document_limit > 0),
  knowledge_file_bytes bigint NOT NULL CHECK (knowledge_file_bytes > 0),
  cloud_eligible boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id, version)
);

INSERT INTO public.membership_plans(
  plan_id, version, knowledge_base_limit, knowledge_document_limit,
  knowledge_file_bytes, cloud_eligible
) VALUES
  ('free', 1, 1, 1, 67108864, false),
  ('pro', 1, 20, 500, 67108864, true)
ON CONFLICT(plan_id, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.membership_accounts (
  user_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id varchar(32) NOT NULL DEFAULT 'free',
  plan_version integer NOT NULL DEFAULT 1,
  state varchar(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  grant_kind varchar(32) CHECK (
    grant_kind IS NULL OR grant_kind IN ('manual_trial', 'manual_grant', 'future_paid')
  ),
  term_ends_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(plan_id, plan_version) REFERENCES public.membership_plans(plan_id, version),
  CHECK (
    (plan_id = 'free' AND grant_kind IS NULL AND term_ends_at IS NULL)
    OR (plan_id = 'pro' AND grant_kind IS NOT NULL AND term_ends_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.membership_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id varchar(128) NOT NULL UNIQUE,
  actor_user_id bigint NOT NULL REFERENCES auth.users(id),
  target_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action varchar(32) NOT NULL CHECK (
    action IN ('grant', 'extend', 'set_expiry', 'revoke', 'correct')
  ),
  reason_code varchar(64) NOT NULL CHECK (
    reason_code IN (
      'manual_payment_confirmed', 'internal_grant', 'customer_compensation', 'trial',
      'renewal', 'refund_revocation', 'risk_revocation', 'operator_correction'
    )
  ),
  note varchar(500),
  previous_version integer NOT NULL CHECK (previous_version >= 0),
  resulting_version integer NOT NULL CHECK (resulting_version > 0),
  previous_state jsonb NOT NULL,
  resulting_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS membership_events_target_created_idx
  ON public.membership_events(target_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.membership_requests (
  request_id varchar(128) PRIMARY KEY,
  actor_user_id bigint NOT NULL REFERENCES auth.users(id),
  target_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input_hash char(32) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.autoforge_membership_summary(p_user_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account public.membership_accounts%ROWTYPE;
  selected_plan public.membership_plans%ROWTYPE;
  effective_status varchar(32);
BEGIN
  INSERT INTO public.membership_accounts(user_id)
  VALUES (p_user_id) ON CONFLICT(user_id) DO NOTHING;
  SELECT * INTO STRICT account FROM public.membership_accounts WHERE user_id = p_user_id;

  effective_status := CASE
    WHEN account.state = 'revoked' THEN 'revoked'
    WHEN account.plan_id = 'pro' AND account.term_ends_at <= clock_timestamp() THEN 'expired'
    ELSE 'active'
  END;
  SELECT * INTO STRICT selected_plan
  FROM public.membership_plans
  WHERE (plan_id, version) = (
    CASE WHEN effective_status = 'active' THEN account.plan_id ELSE 'free' END,
    CASE WHEN effective_status = 'active' THEN account.plan_version ELSE 1 END
  );

  RETURN jsonb_build_object(
    'userId', account.user_id::text,
    'planId', account.plan_id,
    'planVersion', account.plan_version,
    'state', account.state,
    'effectiveStatus', effective_status,
    'grantKind', account.grant_kind,
    'version', account.version,
    'termEndsAt', CASE WHEN account.term_ends_at IS NULL THEN NULL ELSE
      to_char(account.term_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'limits', jsonb_build_object(
      'knowledgeBases', selected_plan.knowledge_base_limit,
      'knowledgeDocuments', selected_plan.knowledge_document_limit,
      'knowledgeFileBytes', selected_plan.knowledge_file_bytes
    ),
    'cloudEligible', effective_status = 'active' AND selected_plan.cloud_eligible,
    'updatedAt', to_char(account.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_membership_get_current(p_caller_user_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE owner bigint;
BEGIN
  IF p_caller_user_id IS NULL OR p_caller_user_id = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001';
  END IF;
  SELECT id INTO owner FROM auth.users WHERE id::text = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0001'; END IF;
  RETURN public.autoforge_membership_summary(owner);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_membership_require_admin(
  p_caller_user_id varchar, p_target_user_id varchar
)
RETURNS TABLE(actor_id bigint, target_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  SELECT users.id INTO actor_id FROM auth.users users WHERE users.id::text = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.app_user_roles roles
  WHERE roles.user_id = actor_id AND roles.role = 'super_admin';
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001'; END IF;
  SELECT users.id INTO target_id FROM auth.users users WHERE users.id::text = p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0001'; END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_membership_get_target(
  p_caller_user_id varchar, p_target_user_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE identity record;
BEGIN
  SELECT * INTO STRICT identity
  FROM public.autoforge_membership_require_admin(p_caller_user_id, p_target_user_id);
  RETURN public.autoforge_membership_summary(identity.target_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_membership_mutate(
  p_caller_user_id varchar,
  p_request_id varchar,
  p_target_user_id varchar,
  p_expected_version integer,
  p_action varchar,
  p_grant_kind varchar,
  p_term_ends_at timestamptz,
  p_reason_code varchar,
  p_note varchar,
  p_plan_id varchar DEFAULT NULL,
  p_state varchar DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  identity record;
  account public.membership_accounts%ROWTYPE;
  replay public.membership_requests%ROWTYPE;
  prior jsonb;
  result jsonb;
  digest char(32);
  now_at timestamptz := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_action NOT IN ('grant', 'extend', 'set_expiry', 'revoke', 'correct')
    OR p_reason_code NOT IN (
      'manual_payment_confirmed', 'internal_grant', 'customer_compensation', 'trial',
      'renewal', 'refund_revocation', 'risk_revocation', 'operator_correction'
    )
    OR p_note IS NOT NULL AND (length(p_note) > 500 OR btrim(p_note) <> p_note) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO STRICT identity
  FROM public.autoforge_membership_require_admin(p_caller_user_id, p_target_user_id);
  IF identity.actor_id = identity.target_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_MEMBERSHIP_CHANGE_FORBIDDEN', ERRCODE = 'P0001';
  END IF;

  digest := md5(concat_ws(E'\n', p_target_user_id, p_expected_version::text, p_action,
    coalesce(p_grant_kind, ''), coalesce(p_term_ends_at::text, ''), p_reason_code,
    coalesce(p_note, ''), coalesce(p_plan_id, ''), coalesce(p_state, '')));
  SELECT * INTO replay FROM public.membership_requests WHERE request_id = p_request_id;
  IF FOUND THEN
    IF replay.actor_user_id <> identity.actor_id OR replay.target_user_id <> identity.target_id
      OR replay.input_hash <> digest THEN
      RAISE EXCEPTION USING MESSAGE = 'REQUEST_ID_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(replay.response, '{status}', '"duplicate"'::jsonb);
  END IF;

  PERFORM pg_advisory_xact_lock(identity.target_id);
  SELECT * INTO replay FROM public.membership_requests WHERE request_id = p_request_id;
  IF FOUND THEN
    IF replay.actor_user_id <> identity.actor_id OR replay.target_user_id <> identity.target_id
      OR replay.input_hash <> digest THEN
      RAISE EXCEPTION USING MESSAGE = 'REQUEST_ID_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(replay.response, '{status}', '"duplicate"'::jsonb);
  END IF;
  INSERT INTO public.membership_accounts(user_id)
  VALUES (identity.target_id) ON CONFLICT(user_id) DO NOTHING;
  SELECT * INTO STRICT account FROM public.membership_accounts
  WHERE user_id = identity.target_id FOR UPDATE;
  IF account.version <> p_expected_version THEN
    RAISE EXCEPTION USING MESSAGE = 'MEMBERSHIP_CONFLICT', ERRCODE = 'P0001';
  END IF;
  prior := public.autoforge_membership_summary(identity.target_id);

  IF p_action = 'grant' THEN
    IF p_grant_kind NOT IN ('manual_trial', 'manual_grant', 'future_paid')
      OR p_term_ends_at IS NULL OR p_term_ends_at <= now_at THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.membership_accounts SET
      plan_id = 'pro', plan_version = 1, state = 'active',
      grant_kind = p_grant_kind, term_ends_at = p_term_ends_at,
      version = version + 1, updated_at = now_at
    WHERE user_id = identity.target_id;
  ELSIF p_action = 'extend' THEN
    IF account.plan_id <> 'pro' OR account.state <> 'active'
      OR p_term_ends_at IS NULL
      OR p_term_ends_at <= greatest(now_at, account.term_ends_at) THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.membership_accounts SET term_ends_at = p_term_ends_at,
      version = version + 1, updated_at = now_at
    WHERE user_id = identity.target_id;
  ELSIF p_action = 'set_expiry' THEN
    IF account.plan_id <> 'pro' OR p_term_ends_at IS NULL OR p_term_ends_at <= now_at THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.membership_accounts SET term_ends_at = p_term_ends_at,
      version = version + 1, updated_at = now_at
    WHERE user_id = identity.target_id;
  ELSIF p_action = 'revoke' THEN
    UPDATE public.membership_accounts SET state = 'revoked',
      version = version + 1, updated_at = now_at
    WHERE user_id = identity.target_id;
  ELSIF p_action = 'correct' THEN
    IF NOT (
      (p_plan_id = 'free' AND p_state IN ('active', 'revoked')
        AND p_grant_kind IS NULL AND p_term_ends_at IS NULL)
      OR (p_plan_id = 'pro' AND p_state IN ('active', 'revoked')
        AND p_grant_kind IN ('manual_trial', 'manual_grant', 'future_paid')
        AND p_term_ends_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.membership_accounts SET
      plan_id = p_plan_id, plan_version = 1, state = p_state,
      grant_kind = p_grant_kind, term_ends_at = p_term_ends_at,
      version = version + 1, updated_at = now_at
    WHERE user_id = identity.target_id;
  ELSE
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;

  result := jsonb_build_object(
    'status', 'applied',
    'membership', public.autoforge_membership_summary(identity.target_id)
  );
  INSERT INTO public.membership_events(
    request_id, actor_user_id, target_user_id, action, reason_code, note,
    previous_version, resulting_version, previous_state, resulting_state
  ) VALUES (
    p_request_id, identity.actor_id, identity.target_id, p_action, p_reason_code, p_note,
    account.version, account.version + 1, prior, result->'membership'
  );
  INSERT INTO public.membership_requests(
    request_id, actor_user_id, target_user_id, input_hash, response
  ) VALUES (p_request_id, identity.actor_id, identity.target_id, digest, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_membership_list_audit(
  p_caller_user_id varchar, p_target_user_id varchar, p_page integer, p_page_size integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  identity record;
BEGIN
  IF p_page IS NULL OR p_page < 1 OR p_page_size NOT IN (20, 50) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO STRICT identity
  FROM public.autoforge_membership_require_admin(p_caller_user_id, p_target_user_id);
  RETURN jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', event.id::text,
        'targetUserId', event.target_user_id::text,
        'actorUserId', event.actor_user_id::text,
        'action', event.action,
        'reasonCode', event.reason_code,
        'previousVersion', event.previous_version,
        'resultingVersion', event.resulting_version,
        'createdAt', to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY event.created_at DESC, event.id DESC)
      FROM (
        SELECT * FROM public.membership_events
        WHERE target_user_id = identity.target_id
        ORDER BY created_at DESC, id DESC
        LIMIT p_page_size OFFSET (p_page - 1) * p_page_size
      ) event
    ), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'total', (SELECT count(*) FROM public.membership_events WHERE target_user_id = identity.target_id)
  );
END;
$$;

REVOKE ALL ON TABLE public.membership_plans FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.membership_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.membership_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.membership_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_summary(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_get_current(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_require_admin(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_get_target(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_mutate(
  varchar, varchar, varchar, integer, varchar, varchar, timestamptz, varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_membership_list_audit(
  varchar, varchar, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autoforge_membership_get_current(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_membership_get_target(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_membership_mutate(
  varchar, varchar, varchar, integer, varchar, varchar, timestamptz, varchar, varchar, varchar, varchar
) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_membership_list_audit(
  varchar, varchar, integer, integer
) TO service_role;
COMMIT;
