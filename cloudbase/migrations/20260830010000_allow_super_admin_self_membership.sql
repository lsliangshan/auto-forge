BEGIN;

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

REVOKE ALL ON FUNCTION public.autoforge_membership_mutate(
  varchar, varchar, varchar, integer, varchar, varchar, timestamptz, varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autoforge_membership_mutate(
  varchar, varchar, varchar, integer, varchar, varchar, timestamptz, varchar, varchar, varchar, varchar
) TO service_role;

COMMIT;
