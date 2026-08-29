BEGIN;

ALTER TABLE public.knowledge_jobs
  ADD COLUMN IF NOT EXISTS cloud_consent_revision bigint CHECK (cloud_consent_revision > 0);
ALTER TABLE public.knowledge_upload_authorizations
  ADD COLUMN IF NOT EXISTS request_id varchar(128),
  ADD COLUMN IF NOT EXISTS version_id varchar(128),
  ADD COLUMN IF NOT EXISTS job_id varchar(128),
  ADD COLUMN IF NOT EXISTS cloud_consent_revision bigint CHECK (cloud_consent_revision > 0);
ALTER TABLE public.knowledge_embedding_dispatch_permits
  ADD COLUMN IF NOT EXISTS cloud_consent_revision bigint CHECK (cloud_consent_revision > 0);

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_current_cloud_consent_revision(
  p_owner_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE consent_revision bigint;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(p_owner_id);
  PERFORM 1 FROM public.knowledge_entitlements
    WHERE owner_id = p_owner_id FOR SHARE;
  PERFORM public.autoforge_knowledge_require_cloud(p_owner_id);
  SELECT revision INTO consent_revision
  FROM public.app_privacy_consent_states
  WHERE owner_user_id = p_owner_id AND purpose = 'cloud_sync'
    AND state = 'accepted' AND document_version = 'cloud-sync-2026-08'
  FOR SHARE;
  IF consent_revision IS NULL OR consent_revision < 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  RETURN consent_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_require_job_cloud_revision(
  p_owner_id bigint, p_job_kind varchar, p_cloud_consent_revision bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE consent_revision bigint;
BEGIN
  IF p_job_kind = 'purge' THEN RETURN; END IF;
  consent_revision := public.autoforge_knowledge_current_cloud_consent_revision(p_owner_id);
  IF p_cloud_consent_revision IS NULL
    OR p_cloud_consent_revision IS DISTINCT FROM consent_revision THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_authorize_upload(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_document_id varchar, p_version_id varchar, p_byte_size bigint, p_sha256 varchar,
  p_mime_type varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  request_row public.knowledge_requests%ROWTYPE;
  authorization public.knowledge_upload_authorizations%ROWTYPE;
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'authorize_upload', 'knowledgeBaseId', p_knowledge_base_id,
    'documentId', p_document_id, 'versionId', p_version_id,
    'byteSize', p_byte_size, 'sha256', p_sha256, 'mimeType', p_mime_type
  ));
  response jsonb;
  object_id varchar := 'object_' || md5(p_request_id || ':' || p_version_id);
  job_id varchar := 'job_' || md5(p_request_id || ':upload');
  upload_ticket varchar := 'upload_' || md5(
    owner::text || ':' || p_request_id || ':' || clock_timestamp()::text
  );
  authorization_expires_at timestamptz := clock_timestamp() + interval '15 minutes';
  storage_ref varchar;
  cloud_revision bigint;
BEGIN
  cloud_revision := public.autoforge_knowledge_current_cloud_consent_revision(owner);
  IF p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 536870912
    OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
    OR p_mime_type IS NULL OR length(p_mime_type) NOT BETWEEN 1 AND 200
    OR btrim(p_mime_type) <> p_mime_type THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF request_row.action <> 'authorize_upload' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO authorization FROM public.knowledge_upload_authorizations
      WHERE owner_id = owner AND request_id = p_request_id
        AND knowledge_base_id = p_knowledge_base_id FOR UPDATE;
    IF NOT FOUND
      OR authorization.cloud_consent_revision IS DISTINCT FROM cloud_revision THEN
      RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner AND deleted_at IS NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  storage_ref := 'knowledge/' || owner::text || '/' || p_knowledge_base_id || '/' || object_id;
  INSERT INTO public.knowledge_objects(
    id, owner_id, knowledge_base_id, storage_reference, byte_size, sha256, mime_type, state
  ) VALUES (
    object_id, owner, p_knowledge_base_id, storage_ref, p_byte_size, p_sha256,
    p_mime_type, 'authorized'
  );
  INSERT INTO public.knowledge_upload_authorizations(
    upload_ticket, owner_id, knowledge_base_id, object_id,
    expected_byte_size, expected_sha256, expected_mime_type, expires_at,
    request_id, version_id, job_id, cloud_consent_revision
  ) VALUES (
    upload_ticket, owner, p_knowledge_base_id, object_id,
    p_byte_size, p_sha256, p_mime_type, authorization_expires_at,
    p_request_id, p_version_id, job_id, cloud_revision
  );
  response := jsonb_build_object(
    'uploadTicket', upload_ticket, 'storageReference', storage_ref,
    'objectId', object_id, 'jobId', job_id, 'mimeType', p_mime_type, 'expiresAt',
    to_char(authorization_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, p_knowledge_base_id, 'authorize_upload', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_get_upload(
  p_caller_user_id varchar, p_upload_ticket varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  authorization public.knowledge_upload_authorizations%ROWTYPE;
  object public.knowledge_objects%ROWTYPE;
BEGIN
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  SELECT * INTO STRICT object FROM public.knowledge_objects
    WHERE id = authorization.object_id AND owner_id = owner
      AND knowledge_base_id = authorization.knowledge_base_id;
  IF NOT (authorization.consumed_at IS NOT NULL AND object.state = 'verified') THEN
    IF authorization.consumed_at IS NOT NULL
      OR authorization.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      owner, 'upload', authorization.cloud_consent_revision
    );
  END IF;
  RETURN jsonb_build_object(
    'ownerId', owner::text, 'knowledgeBaseId', authorization.knowledge_base_id,
    'uploadTicket', authorization.upload_ticket,
    'objectId', object.id, 'storageReference', object.storage_reference,
    'expectedByteSize', authorization.expected_byte_size,
    'expectedSha256', authorization.expected_sha256,
    'expectedMimeType', authorization.expected_mime_type,
    'verified', authorization.consumed_at IS NOT NULL AND object.state = 'verified'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_verify_upload(
  p_caller_user_id varchar, p_upload_ticket varchar,
  p_knowledge_base_id varchar, p_object_id varchar, p_storage_reference varchar,
  p_expected_byte_size bigint, p_expected_sha256 varchar, p_expected_mime_type varchar,
  p_actual_byte_size bigint, p_actual_sha256 varchar, p_actual_mime_type varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  authorization public.knowledge_upload_authorizations%ROWTYPE;
  object public.knowledge_objects%ROWTYPE;
  response jsonb;
BEGIN
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  SELECT * INTO object FROM public.knowledge_objects
    WHERE id = authorization.object_id AND owner_id = owner
      AND knowledge_base_id = authorization.knowledge_base_id FOR UPDATE;
  IF NOT FOUND
    OR authorization.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
    OR authorization.object_id IS DISTINCT FROM p_object_id
    OR object.storage_reference IS DISTINCT FROM p_storage_reference
    OR authorization.expected_byte_size IS DISTINCT FROM p_expected_byte_size
    OR authorization.expected_sha256 IS DISTINCT FROM p_expected_sha256
    OR authorization.expected_mime_type IS DISTINCT FROM p_expected_mime_type
    OR object.byte_size IS DISTINCT FROM p_expected_byte_size
    OR object.sha256 IS DISTINCT FROM p_expected_sha256
    OR object.mime_type IS DISTINCT FROM p_expected_mime_type
    OR authorization.expected_byte_size IS DISTINCT FROM p_actual_byte_size
    OR authorization.expected_sha256 IS DISTINCT FROM p_actual_sha256
    OR authorization.expected_mime_type IS DISTINCT FROM p_actual_mime_type THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  response := jsonb_build_object(
    'ownerId', owner::text, 'knowledgeBaseId', p_knowledge_base_id,
    'uploadTicket', p_upload_ticket, 'objectId', object.id,
    'storageReference', object.storage_reference,
    'byteSize', object.byte_size, 'sha256', object.sha256,
    'mimeType', object.mime_type, 'verified', true
  );
  IF authorization.consumed_at IS NOT NULL THEN
    IF object.state <> 'verified' THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN response;
  END IF;
  IF authorization.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    owner, 'upload', authorization.cloud_consent_revision
  );
  UPDATE public.knowledge_upload_authorizations SET consumed_at = clock_timestamp()
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id AND object_id = p_object_id;
  UPDATE public.knowledge_objects SET state = 'verified', verified_at = clock_timestamp()
    WHERE id = p_object_id AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id
      AND storage_reference = p_storage_reference
    RETURNING * INTO object;
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state,
    cloud_consent_revision
  ) VALUES (
    authorization.job_id, owner, p_knowledge_base_id, authorization.request_id,
    'upload', authorization.version_id, 'queued', authorization.cloud_consent_revision
  );
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_claim_job(
  p_worker_id varchar, p_lease_token varchar, p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE job public.knowledge_jobs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = '' OR length(p_lease_token) > 128
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_jobs SET state = 'failed', error_code = 'LEASE_EXPIRED',
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL,
    updated_at = clock_timestamp()
    WHERE state = 'running' AND attempt >= 3 AND lease_expires_at <= clock_timestamp();
  WITH stale AS (
    SELECT candidate.owner_id, candidate.id
    FROM public.knowledge_jobs candidate
    WHERE candidate.kind <> 'purge' AND candidate.attempt < 3
      AND (candidate.state = 'queued'
        OR (candidate.state = 'running' AND candidate.lease_expires_at <= clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM public.knowledge_entitlements entitlement
        JOIN public.app_privacy_consent_states consent
          ON consent.owner_user_id = candidate.owner_id
          AND consent.purpose = 'cloud_sync' AND consent.state = 'accepted'
          AND consent.document_version = 'cloud-sync-2026-08'
        WHERE entitlement.owner_id = candidate.owner_id
          AND entitlement.tier = 'member' AND entitlement.cloud_enabled
          AND entitlement.status IN ('active', 'offline_grace')
          AND NOT entitlement.kill_switch_enabled
          AND candidate.cloud_consent_revision = consent.revision
      )
    ORDER BY candidate.created_at, candidate.owner_id, candidate.id
    LIMIT 100 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.knowledge_jobs candidate SET state = 'paused', error_code = 'FORBIDDEN',
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL, updated_at = clock_timestamp()
  FROM stale WHERE candidate.owner_id = stale.owner_id AND candidate.id = stale.id;

  SELECT * INTO job FROM public.knowledge_jobs candidate
    WHERE candidate.attempt < 3 AND (
      candidate.state = 'queued'
      OR (candidate.state = 'running' AND candidate.lease_expires_at <= clock_timestamp())
    ) AND (
      candidate.kind = 'purge' OR EXISTS (
        SELECT 1 FROM public.knowledge_entitlements entitlement
        JOIN public.app_privacy_consent_states consent
          ON consent.owner_user_id = candidate.owner_id
          AND consent.purpose = 'cloud_sync' AND consent.state = 'accepted'
          AND consent.document_version = 'cloud-sync-2026-08'
        WHERE entitlement.owner_id = candidate.owner_id
          AND entitlement.tier = 'member' AND entitlement.cloud_enabled
          AND entitlement.status IN ('active', 'offline_grace')
          AND NOT entitlement.kill_switch_enabled
          AND candidate.cloud_consent_revision = consent.revision
      )
    )
    ORDER BY candidate.created_at, candidate.owner_id, candidate.id
    FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('job', NULL); END IF;
  IF job.kind <> 'purge' THEN
    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      job.owner_id, job.kind, job.cloud_consent_revision
    );
  END IF;
  UPDATE public.knowledge_jobs SET state = 'running', attempt = attempt + 1,
    worker_id = p_worker_id, lease_token = p_lease_token,
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    mutation_permit = replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', ''),
    mutation_deadline_at = clock_timestamp() + interval '120 seconds',
    updated_at = clock_timestamp()
    WHERE id = job.id AND owner_id = job.owner_id
    RETURNING * INTO job;
  RETURN jsonb_build_object('job', jsonb_build_object(
    'id', job.id, 'kind', job.kind, 'entityId', job.entity_id,
    'leaseToken', job.lease_token, 'attempt', job.attempt,
    'mutationPermit', job.mutation_permit,
    'mutationBudgetMs', greatest(1, least(120000, floor(extract(
      epoch FROM (job.mutation_deadline_at - clock_timestamp())
    ) * 1000)::integer))
  ));
END;
$$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_get_upload_work(varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT stored.* INTO object$old$,
    $new$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    job.owner_id, job.kind, job.cloud_consent_revision
  );
  SELECT stored.* INTO object$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_get_upload_work revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_issue_embedding_dispatch_permit(varchar,varchar,varchar,integer,bigint,varchar,varchar,varchar,varchar,integer,varchar,varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  new_expiry timestamptz;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);$old$,
    $new$  new_expiry timestamptz;
  cloud_revision bigint;
BEGIN
  cloud_revision := public.autoforge_knowledge_current_cloud_consent_revision(owner);$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_issue_embedding_dispatch_permit admission revision anchor was not found';
  END IF;
  definition := guarded;
  guarded := replace(
    definition,
    $old$    IF permit.state <> 'issued' OR permit.expires_at <= clock_timestamp() THEN$old$,
    $new$    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      owner, 'embedding', permit.cloud_consent_revision
    );
    IF permit.state <> 'issued' OR permit.expires_at <= clock_timestamp() THEN$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_issue_embedding_dispatch_permit replay revision anchor was not found';
  END IF;
  definition := guarded;
  guarded := replace(
    definition,
    $old$      model, dimensions, configuration_version, expires_at
    ) VALUES (
      new_permit_id, owner, p_purpose, p_request_id, p_attempt_id, p_consent_epoch,
      new_provider_request_key,
      p_knowledge_base_id, p_generation_id, p_chunk_id,
      p_model, p_dimensions, p_configuration_version, new_expiry$old$,
    $new$      model, dimensions, configuration_version, cloud_consent_revision, expires_at
    ) VALUES (
      new_permit_id, owner, p_purpose, p_request_id, p_attempt_id, p_consent_epoch,
      new_provider_request_key,
      p_knowledge_base_id, p_generation_id, p_chunk_id,
      p_model, p_dimensions, p_configuration_version, cloud_revision, new_expiry$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_issue_embedding_dispatch_permit persisted revision anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_reserve_embedding_dispatch_attempt(varchar,varchar,varchar,integer,bigint,varchar,varchar,varchar,varchar,integer,varchar,varchar,varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF NOT FOUND OR (permit.state <> 'issued' AND permit.state <> 'dispatching')$old$,
    $new$  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF FOUND THEN
    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      owner, 'embedding', permit.cloud_consent_revision
    );
  END IF;
  IF NOT FOUND OR (permit.state <> 'issued' AND permit.state <> 'dispatching')$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_reserve_embedding_dispatch_attempt revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_mark_embedding_dispatch_started(varchar,varchar,varchar,integer,bigint,varchar,varchar,varchar,varchar,integer,varchar,varchar,varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF NOT FOUND OR permit.state <> 'dispatching'$old$,
    $new$  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF FOUND THEN
    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      owner, 'embedding', permit.cloud_consent_revision
    );
  END IF;
  IF NOT FOUND OR permit.state <> 'dispatching'$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_mark_embedding_dispatch_started revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_complete_upload_index(varchar,varchar,varchar,bigint,varchar,varchar,varchar,varchar,varchar,varchar,varchar,integer,varchar,varchar,jsonb,jsonb,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO object FROM public.knowledge_objects$old$,
    $new$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    job.owner_id, job.kind, job.cloud_consent_revision
  );
  SELECT * INTO object FROM public.knowledge_objects$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_complete_upload_index revision guard anchor was not found';
  END IF;
  definition := guarded;
  guarded := replace(
    definition,
    $old$    INSERT INTO public.knowledge_jobs(
      id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
    ) VALUES (
      embedding_job_id, p_owner_id, p_knowledge_base_id, embedding_request_id,
      'embedding', p_generation_id, 'queued'
    );$old$,
    $new$    INSERT INTO public.knowledge_jobs(
      id, owner_id, knowledge_base_id, request_id, kind, entity_id, state,
      cloud_consent_revision
    ) VALUES (
      embedding_job_id, p_owner_id, p_knowledge_base_id, embedding_request_id,
      'embedding', p_generation_id, 'queued', job.cloud_consent_revision
    );$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_complete_upload_index child revision was not bound';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_begin_embedding_drift_probe(varchar,varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  response jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);$old$,
    $new$  response jsonb;
  cloud_revision bigint;
BEGIN
  cloud_revision := public.autoforge_knowledge_current_cloud_consent_revision(owner);$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_begin_embedding_drift_probe admission revision anchor was not found';
  END IF;
  definition := guarded;
  guarded := replace(
    definition,
    $old$  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (
    job_id, owner, p_knowledge_base_id, p_request_id,
    'embedding', p_generation_id, 'queued'
  );$old$,
    $new$  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state,
    cloud_consent_revision
  ) VALUES (
    job_id, owner, p_knowledge_base_id, p_request_id,
      'embedding', p_generation_id, 'queued', cloud_revision
  );$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_begin_embedding_drift_probe job revision anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_complete_embedding_generation(varchar,varchar,varchar,bigint,varchar,varchar,bigint,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents$old$,
    $new$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    job.owner_id, job.kind, job.cloud_consent_revision
  );
  SELECT * INTO consent FROM public.knowledge_embedding_consents$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_complete_embedding_generation revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_claim_embedding_batch(varchar,varchar,varchar,integer)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents$old$,
    $new$      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    job.owner_id, job.kind, job.cloud_consent_revision
  );
  SELECT * INTO consent FROM public.knowledge_embedding_consents$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_claim_embedding_batch revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_assert_worker_mutation_window(bigint,varchar,bigint,varchar,varchar,varchar,varchar,varchar,varchar,boolean)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$    PERFORM 1 FROM public.knowledge_jobs AS lease_job
      WHERE lease_job.owner_id = p_owner_id AND lease_job.id = p_job_id
        AND lease_job.kind = 'embedding' AND lease_job.state = 'running'
        AND lease_job.knowledge_base_id = p_knowledge_base_id
        AND lease_job.entity_id = p_generation_id
        AND lease_job.worker_id = p_worker_id
        AND lease_job.lease_token = p_lease_token
        AND lease_job.lease_expires_at > clock_timestamp()
        AND lease_job.mutation_permit = p_mutation_permit
        AND lease_job.mutation_deadline_at > clock_timestamp()
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN;$old$,
    $new$    PERFORM 1 FROM public.knowledge_jobs AS lease_job
      WHERE lease_job.owner_id = p_owner_id AND lease_job.id = p_job_id
        AND lease_job.kind = 'embedding' AND lease_job.state = 'running'
        AND lease_job.knowledge_base_id = p_knowledge_base_id
        AND lease_job.entity_id = p_generation_id
        AND lease_job.worker_id = p_worker_id
        AND lease_job.lease_token = p_lease_token
        AND lease_job.lease_expires_at > clock_timestamp()
        AND lease_job.mutation_permit = p_mutation_permit
        AND lease_job.mutation_deadline_at > clock_timestamp()
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    PERFORM public.autoforge_knowledge_require_job_cloud_revision(
      p_owner_id, 'embedding', (
        SELECT lease_job.cloud_consent_revision
        FROM public.knowledge_jobs AS lease_job
        WHERE lease_job.owner_id = p_owner_id AND lease_job.id = p_job_id
      )
    );
    RETURN;$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_assert_worker_mutation_window revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_validate_job_mutation_permit(varchar,varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false);
  END IF;
  RETURN jsonb_build_object('authorized', true);$old$,
    $new$  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false);
  END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    claimed_job.owner_id, claimed_job.kind, claimed_job.cloud_consent_revision
  );
  RETURN jsonb_build_object('authorized', true);$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_validate_job_mutation_permit revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

DO $migration$
DECLARE
  definition text;
  guarded text;
BEGIN
  SELECT pg_get_functiondef(
    'public.autoforge_knowledge_yield_job(varchar,varchar,varchar,varchar)'::regprocedure
  ) INTO definition;
  guarded := replace(
    definition,
    $old$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  UPDATE public.knowledge_jobs SET state = 'queued',$old$,
    $new$  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  PERFORM public.autoforge_knowledge_require_job_cloud_revision(
    job.owner_id, job.kind, job.cloud_consent_revision
  );
  UPDATE public.knowledge_jobs SET state = 'queued',$new$
  );
  IF guarded = definition THEN
    RAISE EXCEPTION 'autoforge_knowledge_yield_job revision guard anchor was not found';
  END IF;
  EXECUTE guarded;
END
$migration$;

-- A revoked or superseded upload can have reached `verified` before the desktop
-- receives its response. It has no published version, so retain its lineage
-- until the normal private-Storage cleanup receipt atomically cancels its job
-- and removes the metadata.
CREATE OR REPLACE FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_storage_references jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  canonical_references jsonb;
  fingerprint char(32);
  request_row public.knowledge_requests%ROWTYPE;
  references_to_delete jsonb;
  current_cloud_revision bigint;
  response jsonb;
BEGIN
  IF jsonb_typeof(p_storage_references) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_storage_references) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_storage_references) supplied(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_agg(reference ORDER BY reference) INTO canonical_references
    FROM (SELECT DISTINCT jsonb_array_elements_text(p_storage_references) reference) refs;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(canonical_references) supplied(reference)
    WHERE length(reference) NOT BETWEEN 1 AND 512
      OR reference !~ '^knowledge/' OR position('..' in reference) > 0) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT revision INTO current_cloud_revision
  FROM public.app_privacy_consent_states
  WHERE owner_user_id = owner AND purpose = 'cloud_sync'
    AND state = 'accepted' AND document_version = 'cloud-sync-2026-08'
  FOR SHARE;
  fingerprint := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'orphan_cleanup', 'knowledgeBaseId', p_knowledge_base_id,
    'storageReferences', canonical_references
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF request_row.action <> 'orphan_cleanup' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT COALESCE(jsonb_agg(object.storage_reference ORDER BY object.storage_reference), '[]'::jsonb)
    INTO references_to_delete
  FROM public.knowledge_objects object
  LEFT JOIN public.knowledge_upload_authorizations authorization
    ON authorization.owner_id = object.owner_id AND authorization.object_id = object.id
  LEFT JOIN public.knowledge_jobs job
    ON job.owner_id = authorization.owner_id AND job.id = authorization.job_id
  WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
    AND object.storage_reference IN (SELECT jsonb_array_elements_text(canonical_references))
    AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
      WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
        AND version.source_object_id = object.id)
    AND (
      object.state IN ('authorized', 'orphaned') OR (
        object.state = 'verified' AND authorization.job_id IS NOT NULL
        AND job.id IS NOT NULL
        AND authorization.cloud_consent_revision IS DISTINCT FROM current_cloud_revision
      )
    );
  IF references_to_delete IS DISTINCT FROM canonical_references THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  response := jsonb_build_object('storageReferences', references_to_delete);
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, p_knowledge_base_id, 'orphan_cleanup', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_storage_references jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  canonical_references jsonb;
  fingerprint char(32);
  request_row public.knowledge_requests%ROWTYPE;
  current_cloud_revision bigint;
  deletable_references jsonb;
  removed integer;
  completed_response jsonb;
BEGIN
  IF jsonb_typeof(p_storage_references) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_storage_references) > 100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_storage_references) supplied(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_agg(reference ORDER BY reference) INTO canonical_references
    FROM (SELECT DISTINCT jsonb_array_elements_text(p_storage_references) reference) refs;
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.action <> 'orphan_cleanup' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  fingerprint := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'orphan_cleanup', 'knowledgeBaseId', p_knowledge_base_id,
    'storageReferences', canonical_references
  ));
  IF request_row.input_hash <> fingerprint THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  IF request_row.response ? 'removed' THEN
    RETURN jsonb_build_object('removed', (request_row.response->>'removed')::integer);
  END IF;
  IF request_row.response->'storageReferences' IS DISTINCT FROM canonical_references THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT revision INTO current_cloud_revision
  FROM public.app_privacy_consent_states
  WHERE owner_user_id = owner AND purpose = 'cloud_sync'
    AND state = 'accepted' AND document_version = 'cloud-sync-2026-08'
  FOR SHARE;
  SELECT COALESCE(jsonb_agg(object.storage_reference ORDER BY object.storage_reference), '[]'::jsonb)
    INTO deletable_references
  FROM public.knowledge_objects object
  LEFT JOIN public.knowledge_upload_authorizations authorization
    ON authorization.owner_id = object.owner_id AND authorization.object_id = object.id
  LEFT JOIN public.knowledge_jobs job
    ON job.owner_id = authorization.owner_id AND job.id = authorization.job_id
  WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
    AND object.storage_reference IN (SELECT jsonb_array_elements_text(canonical_references))
    AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
      WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
        AND version.source_object_id = object.id)
    AND (
      object.state IN ('authorized', 'orphaned') OR (
        object.state = 'verified' AND authorization.job_id IS NOT NULL
        AND job.id IS NOT NULL
        AND authorization.cloud_consent_revision IS DISTINCT FROM current_cloud_revision
      )
    );
  IF deletable_references IS DISTINCT FROM canonical_references THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_jobs job SET state = 'cancelled', error_code = 'FORBIDDEN',
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL, updated_at = clock_timestamp()
  FROM public.knowledge_upload_authorizations authorization
  WHERE authorization.owner_id = owner AND authorization.job_id = job.id
    AND authorization.object_id IN (
      SELECT object.id FROM public.knowledge_objects object
      WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
        AND object.storage_reference IN (SELECT jsonb_array_elements_text(canonical_references))
        AND object.state = 'verified'
        AND authorization.cloud_consent_revision IS DISTINCT FROM current_cloud_revision
    );
  DELETE FROM public.knowledge_objects object
  WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
    AND object.storage_reference IN (SELECT jsonb_array_elements_text(canonical_references))
    AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
      WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
        AND version.source_object_id = object.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  completed_response := jsonb_build_object(
    'storageReferences', canonical_references, 'removed', removed
  );
  UPDATE public.knowledge_requests SET response = completed_response
    WHERE owner_id = owner AND request_id = p_request_id;
  RETURN jsonb_build_object('removed', removed);
END;
$$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_current_cloud_consent_revision(bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_require_job_cloud_revision(bigint, varchar, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_current_cloud_consent_revision(bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_require_job_cloud_revision(bigint, varchar, bigint)
  TO service_role;

COMMIT;
