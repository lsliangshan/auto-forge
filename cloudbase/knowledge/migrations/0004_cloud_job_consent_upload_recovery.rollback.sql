BEGIN;

-- Column additions are intentionally retained so rollback cannot discard recovery
-- or consent lineage already written by the forward migration. The executable
-- surface is restored to the immediately preceding migration behavior.
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
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 536870912
    OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
    OR p_mime_type IS NULL OR length(p_mime_type) NOT BETWEEN 1 AND 200
    OR btrim(p_mime_type) <> p_mime_type THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'authorize_upload' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
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
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (job_id, owner, p_knowledge_base_id, p_request_id, 'upload', p_version_id, 'queued');
  INSERT INTO public.knowledge_upload_authorizations(
    upload_ticket, owner_id, knowledge_base_id, object_id,
    expected_byte_size, expected_sha256, expected_mime_type, expires_at
  ) VALUES (
    upload_ticket, owner, p_knowledge_base_id, object_id,
    p_byte_size, p_sha256, p_mime_type, authorization_expires_at
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
  IF authorization.consumed_at IS NOT NULL OR authorization.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO STRICT object FROM public.knowledge_objects
    WHERE id = authorization.object_id AND owner_id = owner
      AND knowledge_base_id = authorization.knowledge_base_id;
  RETURN jsonb_build_object(
    'ownerId', owner::text, 'knowledgeBaseId', authorization.knowledge_base_id,
    'uploadTicket', authorization.upload_ticket,
    'objectId', object.id, 'storageReference', object.storage_reference,
    'expectedByteSize', authorization.expected_byte_size,
    'expectedSha256', authorization.expected_sha256,
    'expectedMimeType', authorization.expected_mime_type
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
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT * INTO authorization FROM public.knowledge_upload_authorizations
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  SELECT * INTO object FROM public.knowledge_objects
    WHERE id = authorization.object_id AND owner_id = owner
      AND knowledge_base_id = authorization.knowledge_base_id FOR UPDATE;
  IF NOT FOUND
    OR authorization.consumed_at IS NOT NULL OR authorization.expires_at <= clock_timestamp()
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
  UPDATE public.knowledge_upload_authorizations SET consumed_at = clock_timestamp()
    WHERE upload_ticket = p_upload_ticket AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id AND object_id = p_object_id;
  UPDATE public.knowledge_objects SET state = 'verified', verified_at = clock_timestamp()
    WHERE id = p_object_id AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id
      AND storage_reference = p_storage_reference
    RETURNING * INTO object;
  RETURN jsonb_build_object(
    'ownerId', owner::text, 'knowledgeBaseId', p_knowledge_base_id,
    'uploadTicket', p_upload_ticket, 'objectId', object.id,
    'storageReference', object.storage_reference,
    'byteSize', object.byte_size, 'sha256', object.sha256,
    'mimeType', object.mime_type, 'verified', true
  );
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
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE attempt < 3 AND (
      state = 'queued' OR (state = 'running' AND lease_expires_at <= clock_timestamp())
    ) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('job', NULL); END IF;
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

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_get_upload_work(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  object public.knowledge_objects%ROWTYPE;
  head public.knowledge_entity_heads%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = '' OR length(p_job_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = ''
    OR length(p_lease_token) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE id = p_job_id AND kind = 'upload' AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT stored.* INTO object
    FROM public.knowledge_requests request
    JOIN public.knowledge_objects stored
      ON stored.owner_id = request.owner_id
      AND stored.knowledge_base_id = request.knowledge_base_id
      AND stored.id = request.response->>'objectId'
    WHERE request.owner_id = job.owner_id AND request.request_id = job.request_id
      AND request.action = 'authorize_upload'
    FOR UPDATE OF stored;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  IF object.state IN ('authorized', 'uploaded') THEN
    RAISE EXCEPTION USING MESSAGE = 'TRANSIENT_FAILURE', ERRCODE = 'P0001';
  END IF;
  IF object.state <> 'verified' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.knowledge_entity_heads candidate
      WHERE candidate.owner_id = job.owner_id
        AND candidate.knowledge_base_id = job.knowledge_base_id
        AND candidate.entity_kind = 'document'
        AND candidate.payload->>'versionId' = job.entity_id
        AND NOT candidate.deleted) <> 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO head FROM public.knowledge_entity_heads
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id
      AND entity_kind = 'document' AND payload->>'versionId' = job.entity_id
      AND NOT deleted FOR UPDATE;
  IF NOT FOUND OR head.payload->>'versionId' IS DISTINCT FROM job.entity_id
    OR head.payload->>'name' IS NULL OR btrim(head.payload->>'name') = ''
    OR length(head.payload->>'name') > 500
    OR head.payload->>'mimeType' IS DISTINCT FROM object.mime_type
    OR head.payload->>'contentHash' IS DISTINCT FROM object.sha256
    OR head.payload->>'generationId' IS NULL
    OR length(head.payload->>'generationId') NOT BETWEEN 1 AND 128
    OR COALESCE(head.payload->>'versionNumber', '') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.knowledge_index_generations generation
    WHERE generation.owner_id = job.owner_id
      AND generation.knowledge_base_id = job.knowledge_base_id
      AND generation.id = head.payload->>'generationId'
      AND generation.status = 'staging'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'ownerId', job.owner_id::text, 'knowledgeBaseId', job.knowledge_base_id,
    'documentId', head.entity_id, 'versionId', job.entity_id,
    'generationId', head.payload->>'generationId', 'objectId', object.id,
    'storageReference', object.storage_reference, 'byteSize', object.byte_size,
    'sha256', object.sha256, 'mimeType', object.mime_type,
    'name', head.payload->>'name',
    'versionNumber', (head.payload->>'versionNumber')::integer
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_upload_index(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_owner_id bigint, p_knowledge_base_id varchar, p_document_id varchar,
  p_version_id varchar, p_generation_id varchar, p_object_id varchar,
  p_name varchar, p_mime_type varchar, p_version_number integer,
  p_content_hash varchar, p_parser_version varchar, p_blocks jsonb, p_chunks jsonb,
  p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  object public.knowledge_objects%ROWTYPE;
  generation public.knowledge_index_generations%ROWTYPE;
  head public.knowledge_entity_heads%ROWTYPE;
  document public.knowledge_documents%ROWTYPE;
  block_item jsonb;
  chunk_item jsonb;
  parser_run_id varchar := 'parse_' || md5(p_owner_id::text || ':' || p_version_id);
  embedding_job_id varchar := 'job_' || md5(p_owner_id::text || ':' || p_generation_id || ':embedding');
  embedding_request_id varchar := 'worker_embedding_' || md5(
    p_owner_id::text || ':' || p_generation_id
  );
  enqueue_embedding boolean := false;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = '' OR length(p_job_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = '' OR length(p_lease_token) > 128
    OR p_owner_id IS NULL OR p_owner_id <= 0
    OR p_knowledge_base_id IS NULL OR length(p_knowledge_base_id) NOT BETWEEN 1 AND 128
    OR p_document_id IS NULL OR length(p_document_id) NOT BETWEEN 1 AND 128
    OR p_version_id IS NULL OR length(p_version_id) NOT BETWEEN 1 AND 128
    OR p_generation_id IS NULL OR length(p_generation_id) NOT BETWEEN 1 AND 128
    OR p_object_id IS NULL OR length(p_object_id) NOT BETWEEN 1 AND 128
    OR p_name IS NULL OR btrim(p_name) = '' OR btrim(p_name) <> p_name OR length(p_name) > 500
    OR p_mime_type IS NULL OR btrim(p_mime_type) = ''
    OR btrim(p_mime_type) <> p_mime_type OR length(p_mime_type) > 200
    OR p_version_number IS NULL OR p_version_number < 1
    OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$'
    OR p_parser_version IS NULL OR btrim(p_parser_version) = ''
    OR length(p_parser_version) > 128
    OR jsonb_typeof(p_blocks) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_blocks) NOT BETWEEN 1 AND 10000
    OR jsonb_array_length(p_chunks) NOT BETWEEN 1 AND 10000
    OR pg_column_size(p_blocks) + pg_column_size(p_chunks) > 786432
    OR p_mutation_permit IS NULL OR btrim(p_mutation_permit) = ''
    OR length(p_mutation_permit) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  FOR block_item IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    IF jsonb_typeof(block_item) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(block_item)) <> 5
      OR NOT (block_item ?& array['id', 'ordinal', 'kind', 'body', 'coordinates'])
      OR jsonb_typeof(block_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(block_item->'ordinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(block_item->'kind') IS DISTINCT FROM 'string'
      OR jsonb_typeof(block_item->'body') IS DISTINCT FROM 'string'
      OR jsonb_typeof(block_item->'coordinates') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    IF length(block_item->>'id') NOT BETWEEN 1 AND 128
      OR COALESCE(block_item->>'ordinal', '') !~ '^(0|[1-9][0-9]{0,8})$'
      OR length(block_item->>'kind') NOT BETWEEN 1 AND 64
      OR length(block_item->>'body') NOT BETWEEN 1 AND 65536
      OR pg_column_size(block_item->'coordinates') > 8192 THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOR chunk_item IN SELECT value FROM jsonb_array_elements(p_chunks) LOOP
    IF jsonb_typeof(chunk_item) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(chunk_item)) <> 5
      OR NOT (chunk_item ?& array['id', 'blockId', 'ordinal', 'body', 'coordinates'])
      OR jsonb_typeof(chunk_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(chunk_item->'blockId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(chunk_item->'ordinal') IS DISTINCT FROM 'number'
      OR jsonb_typeof(chunk_item->'body') IS DISTINCT FROM 'string'
      OR jsonb_typeof(chunk_item->'coordinates') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
    IF length(chunk_item->>'id') NOT BETWEEN 1 AND 128
      OR length(chunk_item->>'blockId') NOT BETWEEN 1 AND 128
      OR COALESCE(chunk_item->>'ordinal', '') !~ '^(0|[1-9][0-9]{0,8})$'
      OR length(chunk_item->>'body') NOT BETWEEN 1 AND 65536
      OR pg_column_size(chunk_item->'coordinates') > 8192 THEN
      RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT value->>'id')
        OR count(*) <> count(DISTINCT value->>'ordinal')
      FROM jsonb_array_elements(p_blocks))
    OR (SELECT count(*) <> count(DISTINCT value->>'id')
        OR count(*) <> count(DISTINCT value->>'ordinal')
      FROM jsonb_array_elements(p_chunks))
    OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) supplied
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_blocks) block
      WHERE block.value->>'id' = supplied.value->>'blockId'
    )
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE owner_id = p_owner_id AND id = p_job_id
      AND knowledge_base_id = p_knowledge_base_id
      AND kind = 'upload' AND entity_id = p_version_id AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO object FROM public.knowledge_objects
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_object_id AND state = 'verified' FOR UPDATE;
  IF NOT FOUND OR object.sha256 IS DISTINCT FROM p_content_hash
    OR object.mime_type IS DISTINCT FROM p_mime_type THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id AND status = 'staging' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO head FROM public.knowledge_entity_heads
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND entity_kind = 'document' AND entity_id = p_document_id
      AND NOT deleted FOR UPDATE;
  IF NOT FOUND OR head.payload->>'versionId' IS DISTINCT FROM p_version_id
    OR head.payload->>'generationId' IS DISTINCT FROM p_generation_id
    OR head.payload->>'name' IS DISTINCT FROM p_name
    OR head.payload->>'mimeType' IS DISTINCT FROM p_mime_type
    OR head.payload->>'contentHash' IS DISTINCT FROM p_content_hash
    OR head.payload->>'versionNumber' IS DISTINCT FROM p_version_number::text THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO document FROM public.knowledge_documents
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_document_id FOR UPDATE;
  IF FOUND AND (document.status = 'deleted' OR document.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.knowledge_documents(
      id, owner_id, knowledge_base_id, name, mime_type, revision, status
    ) VALUES (
      p_document_id, p_owner_id, p_knowledge_base_id, p_name, p_mime_type,
      head.revision, 'staging'
    );
  END IF;
  INSERT INTO public.knowledge_versions(
    id, owner_id, knowledge_base_id, document_id, source_object_id,
    version_number, content_hash, status
  ) VALUES (
    p_version_id, p_owner_id, p_knowledge_base_id, p_document_id, p_object_id,
    p_version_number, p_content_hash, 'staging'
  );
  INSERT INTO public.knowledge_parser_runs(
    id, owner_id, knowledge_base_id, version_id, status, parser_version,
    error_code, updated_at
  ) VALUES (
    parser_run_id, p_owner_id, p_knowledge_base_id, p_version_id,
    'completed', p_parser_version, NULL, clock_timestamp()
  );
  INSERT INTO public.knowledge_blocks(
    id, owner_id, knowledge_base_id, version_id, ordinal, kind, body, coordinates
  ) SELECT supplied.value->>'id', p_owner_id, p_knowledge_base_id, p_version_id,
      (supplied.value->>'ordinal')::integer, supplied.value->>'kind',
      supplied.value->>'body', supplied.value->'coordinates'
    FROM jsonb_array_elements(p_blocks) supplied;
  INSERT INTO public.knowledge_chunks(
    id, owner_id, knowledge_base_id, document_id, version_id,
    block_id, ordinal, body, coordinates
  ) SELECT supplied.value->>'id', p_owner_id, p_knowledge_base_id, p_document_id,
      p_version_id, supplied.value->>'blockId',
      (supplied.value->>'ordinal')::integer, supplied.value->>'body',
      supplied.value->'coordinates'
    FROM jsonb_array_elements(p_chunks) supplied;
  UPDATE public.knowledge_versions SET status = 'retired'
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND document_id = p_document_id AND id = document.active_version_id
      AND status = 'ready';
  UPDATE public.knowledge_versions SET status = 'ready', ready_at = clock_timestamp()
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_version_id AND status = 'staging';
  UPDATE public.knowledge_documents SET name = p_name, mime_type = p_mime_type,
    active_version_id = p_version_id, revision = head.revision,
    status = 'ready', updated_at = clock_timestamp(), deleted_at = NULL
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_document_id;
  INSERT INTO public.knowledge_generation_memberships(
    owner_id, knowledge_base_id, generation_id, chunk_id, version_id, ordinal
  ) SELECT p_owner_id, p_knowledge_base_id, p_generation_id, frozen.id,
      frozen.version_id, frozen.manifest_ordinal
    FROM (
      SELECT chunk.id, chunk.version_id,
        (row_number() OVER (
          ORDER BY chunk.document_id, chunk.version_id, chunk.ordinal, chunk.id
        ) - 1)::integer AS manifest_ordinal
      FROM public.knowledge_chunks chunk
      JOIN public.knowledge_documents active_document
        ON active_document.owner_id = chunk.owner_id
        AND active_document.knowledge_base_id = chunk.knowledge_base_id
        AND active_document.id = chunk.document_id
        AND active_document.active_version_id = chunk.version_id
        AND active_document.status = 'ready' AND active_document.deleted_at IS NULL
      JOIN public.knowledge_versions active_version
        ON active_version.owner_id = chunk.owner_id
        AND active_version.knowledge_base_id = chunk.knowledge_base_id
        AND active_version.id = chunk.version_id AND active_version.status = 'ready'
      WHERE chunk.owner_id = p_owner_id
        AND chunk.knowledge_base_id = p_knowledge_base_id
    ) frozen;
  SELECT EXISTS (
    SELECT 1 FROM public.knowledge_embedding_consents consent
    WHERE consent.owner_id = p_owner_id AND consent.state = 'granted'
  ) INTO enqueue_embedding;
  IF enqueue_embedding THEN
    INSERT INTO public.knowledge_jobs(
      id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
    ) VALUES (
      embedding_job_id, p_owner_id, p_knowledge_base_id, embedding_request_id,
      'embedding', p_generation_id, 'queued'
    );
  ELSE
    UPDATE public.knowledge_index_generations
      SET status = 'ready', ready_at = clock_timestamp()
      WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
        AND id = p_generation_id AND status = 'staging';
  END IF;
  UPDATE public.knowledge_jobs SET state = 'completed', error_code = NULL,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL,
    updated_at = clock_timestamp()
    WHERE owner_id = p_owner_id AND id = p_job_id AND kind = 'upload'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'completed', true, 'generationId', p_generation_id,
    'embeddingJobId', CASE WHEN enqueue_embedding THEN embedding_job_id ELSE NULL END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_yield_job(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = '' OR length(p_job_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = ''
    OR length(p_lease_token) > 128 OR p_mutation_permit IS NULL
    OR btrim(p_mutation_permit) = '' OR length(p_mutation_permit) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE id = p_job_id AND kind = 'embedding' AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  UPDATE public.knowledge_jobs SET state = 'queued',
    attempt = greatest(attempt - 1, 0), error_code = NULL,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL,
    updated_at = clock_timestamp()
    WHERE owner_id = job.owner_id AND id = job.id
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('yielded', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_begin_embedding_drift_probe(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_generation_id varchar, p_expected_published_generation_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  base public.knowledge_bases%ROWTYPE;
  consent public.knowledge_embedding_consents%ROWTYPE;
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'begin_embedding_drift_probe',
    'knowledgeBaseId', p_knowledge_base_id, 'generationId', p_generation_id,
    'expectedPublishedGenerationId', p_expected_published_generation_id
  ));
  job_id varchar := 'job_' || md5(p_request_id || ':embedding');
  response jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'begin_embedding_drift_probe'
      OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT * INTO base FROM public.knowledge_bases
    WHERE owner_id = owner AND id = p_knowledge_base_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  IF base.published_generation_id IS DISTINCT FROM p_expected_published_generation_id THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR SHARE;
  IF NOT FOUND OR consent.state <> 'granted' THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.knowledge_index_generations(
    id, owner_id, knowledge_base_id, status
  ) VALUES (p_generation_id, owner, p_knowledge_base_id, 'staging');
  INSERT INTO public.knowledge_generation_memberships(
    owner_id, knowledge_base_id, generation_id, chunk_id, version_id, ordinal
  )
  SELECT owner, p_knowledge_base_id, p_generation_id, frozen.id, frozen.version_id,
    frozen.manifest_ordinal
  FROM (
    SELECT chunk.id, chunk.version_id,
      (row_number() OVER (
        ORDER BY chunk.document_id, chunk.version_id, chunk.ordinal, chunk.id
      ) - 1)::integer AS manifest_ordinal
    FROM public.knowledge_chunks chunk
    JOIN public.knowledge_documents document
      ON document.owner_id = chunk.owner_id
      AND document.knowledge_base_id = chunk.knowledge_base_id
      AND document.id = chunk.document_id
      AND document.active_version_id = chunk.version_id
      AND document.status = 'ready' AND document.deleted_at IS NULL
    JOIN public.knowledge_versions version
      ON version.owner_id = chunk.owner_id
      AND version.knowledge_base_id = chunk.knowledge_base_id
      AND version.id = chunk.version_id AND version.status = 'ready'
    WHERE chunk.owner_id = owner
      AND chunk.knowledge_base_id = p_knowledge_base_id
  ) frozen;
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (
    job_id, owner, p_knowledge_base_id, p_request_id,
    'embedding', p_generation_id, 'queued'
  );
  response := jsonb_build_object(
    'generationId', p_generation_id,
    'previousGenerationId', base.published_generation_id,
    'jobId', job_id, 'status', 'staging'
  );
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (
    owner, p_request_id, p_knowledge_base_id,
    'begin_embedding_drift_probe', fingerprint, response
  );
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_embedding_generation(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_owner_id bigint, p_knowledge_base_id varchar, p_generation_id varchar,
  p_consent_epoch bigint, p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  consent public.knowledge_embedding_consents%ROWTYPE;
  generation public.knowledge_index_generations%ROWTYPE;
BEGIN
  IF p_mutation_permit IS NULL OR btrim(p_mutation_permit) = ''
    OR length(p_mutation_permit) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE owner_id = p_owner_id AND id = p_job_id
      AND knowledge_base_id = p_knowledge_base_id
      AND kind = 'embedding' AND entity_id = p_generation_id
      AND state = 'running' AND worker_id = p_worker_id
      AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = job.owner_id FOR SHARE;
  IF NOT FOUND OR consent.state <> 'granted'
    OR consent.consent_epoch <> p_consent_epoch THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id
      AND id = job.entity_id AND status = 'staging' FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.knowledge_generation_memberships membership
    WHERE membership.owner_id = job.owner_id
      AND membership.knowledge_base_id = job.knowledge_base_id
      AND membership.generation_id = generation.id
      AND NOT EXISTS (
        SELECT 1 FROM public.knowledge_chunk_embeddings embedding
        WHERE embedding.owner_id = membership.owner_id
          AND embedding.knowledge_base_id = membership.knowledge_base_id
          AND embedding.generation_id = generation.id
          AND embedding.chunk_id = membership.chunk_id
          AND embedding.version_id = membership.version_id
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_index_generations
    SET status = 'ready', ready_at = clock_timestamp()
    WHERE owner_id = generation.owner_id
      AND knowledge_base_id = generation.knowledge_base_id AND id = generation.id;
  UPDATE public.knowledge_jobs SET state = 'completed', worker_id = NULL,
    lease_token = NULL, lease_expires_at = NULL, error_code = NULL,
    mutation_permit = NULL, mutation_deadline_at = NULL,
    updated_at = clock_timestamp()
    WHERE owner_id = job.owner_id AND id = job.id AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND mutation_permit = p_mutation_permit
      AND mutation_deadline_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ready', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_assert_worker_mutation_window(
  p_owner_id bigint, p_purpose varchar, p_consent_epoch bigint,
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_knowledge_base_id varchar, p_generation_id varchar,
  p_mutation_permit varchar, p_allow_revocation_recovery boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE consent public.knowledge_embedding_consents%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_purpose NOT IN ('query', 'chunk')
    OR p_consent_epoch IS NULL OR p_consent_epoch < 0
    OR p_allow_revocation_recovery IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_purpose = 'query' THEN
    IF p_worker_id IS NOT NULL OR p_job_id IS NOT NULL OR p_lease_token IS NOT NULL
      OR p_mutation_permit IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF p_worker_id IS NOT NULL AND btrim(p_worker_id) <> ''
    AND p_job_id IS NOT NULL AND btrim(p_job_id) <> ''
    AND p_lease_token IS NOT NULL AND btrim(p_lease_token) <> ''
    AND p_mutation_permit IS NOT NULL AND btrim(p_mutation_permit) <> ''
    AND length(p_mutation_permit) <= 128 THEN
    PERFORM 1 FROM public.knowledge_jobs AS lease_job
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
    RETURN;
  END IF;
  IF NOT p_allow_revocation_recovery OR p_worker_id IS NOT NULL
    OR p_job_id IS NOT NULL OR p_lease_token IS NOT NULL
    OR p_mutation_permit IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = p_owner_id FOR SHARE;
  IF NOT FOUND OR consent.state <> 'revoking'
    OR consent.consent_epoch <= p_consent_epoch THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_validate_job_mutation_permit(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_mutation_permit varchar, p_mutation_kind varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed_job public.knowledge_jobs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = '' OR length(p_job_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = '' OR length(p_lease_token) > 128
    OR p_mutation_permit IS NULL OR btrim(p_mutation_permit) = ''
    OR length(p_mutation_permit) > 128
    OR p_mutation_kind NOT IN ('storage_delete', 'tokenhub_embedding') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT job.* INTO claimed_job FROM public.knowledge_jobs job
    WHERE job.id = p_job_id AND job.state = 'running'
      AND job.worker_id = p_worker_id
      AND job.lease_token = p_lease_token
      AND job.lease_expires_at > clock_timestamp()
      AND job.mutation_permit = p_mutation_permit
      AND job.mutation_deadline_at > clock_timestamp()
      AND NOT (p_mutation_kind = 'storage_delete' AND job.kind <> 'purge')
      AND NOT (p_mutation_kind = 'tokenhub_embedding' AND job.kind <> 'embedding')
    FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false);
  END IF;
  RETURN jsonb_build_object('authorized', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_claim_embedding_batch(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  consent public.knowledge_embedding_consents%ROWTYPE;
  generation public.knowledge_index_generations%ROWTYPE;
  chunks jsonb;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = ''
    OR p_job_id IS NULL OR btrim(p_job_id) = ''
    OR p_lease_token IS NULL OR btrim(p_lease_token) = ''
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE id = p_job_id AND kind = 'embedding' AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = job.owner_id;
  IF NOT FOUND OR consent.state <> 'granted' THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id
      AND id = job.entity_id AND status IN ('staging', 'ready');
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', candidate.id, 'versionId', candidate.version_id, 'body', candidate.body
  ) ORDER BY candidate.ordinal, candidate.id), '[]'::jsonb)
  INTO chunks
  FROM (
    SELECT chunk.id, membership.version_id, chunk.body, membership.ordinal
    FROM public.knowledge_generation_memberships membership
    JOIN public.knowledge_chunks chunk
      ON chunk.owner_id = membership.owner_id
      AND chunk.knowledge_base_id = membership.knowledge_base_id
      AND chunk.id = membership.chunk_id
      AND chunk.version_id = membership.version_id
    LEFT JOIN public.knowledge_chunk_embeddings embedding
      ON embedding.owner_id = membership.owner_id
      AND embedding.knowledge_base_id = membership.knowledge_base_id
      AND embedding.generation_id = generation.id
      AND embedding.chunk_id = membership.chunk_id
      AND embedding.version_id = membership.version_id
    WHERE membership.owner_id = job.owner_id
      AND membership.knowledge_base_id = job.knowledge_base_id
      AND membership.generation_id = generation.id
      AND embedding.chunk_id IS NULL
    ORDER BY membership.ordinal, membership.chunk_id
    LIMIT p_limit
  ) candidate;
  RETURN jsonb_build_object(
    'ownerId', job.owner_id::text, 'knowledgeBaseId', job.knowledge_base_id,
    'generationId', generation.id, 'consentEpoch', consent.consent_epoch,
    'chunks', chunks
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_issue_embedding_dispatch_permit(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar,
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_owner_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  permit public.knowledge_embedding_dispatch_permits%ROWTYPE;
  new_permit_id varchar(128);
  new_provider_request_key varchar(128);
  new_expiry timestamptz;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_purpose NOT IN ('query', 'chunk')
    OR p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_attempt_id IS NULL OR p_attempt_id NOT BETWEEN 1 AND 3
    OR p_consent_epoch IS NULL OR p_consent_epoch < 0
    OR p_model <> 'kinfra-text-embedding-0.6b' OR p_dimensions <> 1024
    OR p_configuration_version <> 'autoforge-knowledge-embedding-v1'
    OR (p_purpose = 'query' AND (p_knowledge_base_id IS NOT NULL
      OR p_generation_id IS NOT NULL OR p_chunk_id IS NOT NULL))
    OR (p_purpose = 'chunk' AND (p_knowledge_base_id IS NULL
      OR p_generation_id IS NULL OR p_chunk_id IS NULL)) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    owner::text || ':' || p_purpose || ':' || p_request_id, 0
  ));
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  IF NOT FOUND OR consent.state <> 'granted'
    OR consent.consent_epoch <> p_consent_epoch
    OR (p_purpose = 'query' AND consent.rebuild_required) THEN
    RETURN jsonb_build_object('issued', false);
  END IF;
  IF p_purpose = 'chunk' AND NOT EXISTS (
    SELECT 1 FROM public.knowledge_generation_memberships membership
    WHERE membership.owner_id = owner
      AND membership.knowledge_base_id = p_knowledge_base_id
      AND membership.generation_id = p_generation_id
      AND membership.chunk_id = p_chunk_id
  ) THEN
    RETURN jsonb_build_object('issued', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_embedding_dispatch_permits bound
    WHERE bound.owner_id = owner AND bound.purpose = p_purpose
      AND bound.request_id = p_request_id
      AND (bound.consent_epoch IS DISTINCT FROM p_consent_epoch
        OR bound.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
        OR bound.generation_id IS DISTINCT FROM p_generation_id
        OR bound.chunk_id IS DISTINCT FROM p_chunk_id
        OR bound.model IS DISTINCT FROM p_model
        OR bound.dimensions IS DISTINCT FROM p_dimensions
        OR bound.configuration_version IS DISTINCT FROM p_configuration_version)
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND purpose = p_purpose AND request_id = p_request_id
      AND attempt_id = p_attempt_id
    FOR UPDATE;
  IF FOUND THEN
    IF permit.consent_epoch IS DISTINCT FROM p_consent_epoch
      OR permit.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
      OR permit.generation_id IS DISTINCT FROM p_generation_id
      OR permit.chunk_id IS DISTINCT FROM p_chunk_id
      OR permit.model IS DISTINCT FROM p_model
      OR permit.dimensions IS DISTINCT FROM p_dimensions
      OR permit.configuration_version IS DISTINCT FROM p_configuration_version THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF permit.state IN ('started', 'completed', 'failed') THEN
      RETURN jsonb_build_object(
        'issued', false, 'recovery', jsonb_build_object(
          'state', CASE WHEN permit.state = 'started'
              AND permit.settlement_outcome IS NOT NULL
            THEN 'settlement_pending' ELSE permit.state END,
          'permitId', permit.permit_id, 'purpose', permit.purpose,
          'requestId', permit.request_id, 'attemptId', permit.attempt_id,
          'consentEpoch', permit.consent_epoch,
          'providerRequestKey', permit.provider_request_key,
          'outcome', permit.settlement_outcome,
          'responseHash', permit.provider_response_hash,
          'retryable', COALESCE(permit.provider_retryable, false),
          'embedding', jsonb_build_object(
            'model', permit.model, 'dimensions', permit.dimensions,
            'configurationVersion', permit.configuration_version,
            'region', 'guangzhou'
          )
        )
      );
    END IF;
    IF permit.state <> 'issued' OR permit.expires_at <= clock_timestamp() THEN
      IF permit.state = 'issued' THEN
        UPDATE public.knowledge_embedding_dispatch_permits SET state = 'expired'
          WHERE owner_id = owner AND permit_id = permit.permit_id;
        PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
          owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
          p_knowledge_base_id, p_generation_id, p_mutation_permit, false
        );
      END IF;
      RETURN jsonb_build_object('issued', false);
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.knowledge_embedding_dispatch_permits completed
      WHERE completed.owner_id = owner AND completed.purpose = p_purpose
        AND completed.request_id = p_request_id AND completed.state = 'completed'
    ) OR (
      p_attempt_id > 1 AND (
        SELECT count(*) FROM public.knowledge_embedding_dispatch_permits prior
        WHERE prior.owner_id = owner AND prior.purpose = p_purpose
          AND prior.request_id = p_request_id AND prior.attempt_id < p_attempt_id
          AND prior.state = 'failed'
      ) <> p_attempt_id - 1
    ) OR EXISTS (
      SELECT 1 FROM public.knowledge_embedding_dispatch_permits active
      WHERE active.owner_id = owner AND active.purpose = p_purpose
        AND active.request_id = p_request_id
        AND active.state IN ('issued', 'dispatching', 'started')
    ) THEN
      RETURN jsonb_build_object('issued', false);
    END IF;
    new_permit_id := 'permit_' || md5(
      owner::text || ':' || p_purpose || ':' || p_request_id || ':'
      || clock_timestamp()::text || ':' || random()::text
    );
    new_provider_request_key := 'embed_' || md5(jsonb_build_array(
      owner, p_purpose, p_request_id, p_attempt_id, p_consent_epoch,
      p_knowledge_base_id, p_generation_id, p_chunk_id, p_configuration_version
    )::text);
    IF p_purpose = 'chunk' THEN
      SELECT least(clock_timestamp() + interval '15 seconds', job.mutation_deadline_at)
        INTO new_expiry FROM public.knowledge_jobs job
        WHERE job.id = p_job_id AND job.worker_id = p_worker_id
          AND job.lease_token = p_lease_token
          AND job.mutation_permit = p_mutation_permit;
    ELSE
      new_expiry := clock_timestamp() + interval '15 seconds';
    END IF;
    INSERT INTO public.knowledge_embedding_dispatch_permits(
      permit_id, owner_id, purpose, request_id, attempt_id, consent_epoch,
      provider_request_key,
      knowledge_base_id, generation_id, chunk_id,
      model, dimensions, configuration_version, expires_at
    ) VALUES (
      new_permit_id, owner, p_purpose, p_request_id, p_attempt_id, p_consent_epoch,
      new_provider_request_key,
      p_knowledge_base_id, p_generation_id, p_chunk_id,
      p_model, p_dimensions, p_configuration_version, new_expiry
    ) RETURNING * INTO permit;
  END IF;
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  RETURN jsonb_build_object(
    'issued', true, 'permitId', permit.permit_id,
    'purpose', permit.purpose, 'requestId', permit.request_id,
    'attemptId', permit.attempt_id,
    'consentEpoch', permit.consent_epoch, 'expiresAt', permit.expires_at,
    'providerRequestKey', permit.provider_request_key,
    'embedding', jsonb_build_object(
      'model', permit.model, 'dimensions', permit.dimensions,
      'configurationVersion', permit.configuration_version, 'region', 'guangzhou'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_reserve_embedding_dispatch_attempt(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar,
  p_permit_id varchar, p_worker_id varchar, p_job_id varchar,
  p_lease_token varchar, p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_owner_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  permit public.knowledge_embedding_dispatch_permits%ROWTYPE;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_permit_id IS NULL OR btrim(p_permit_id) = '' OR length(p_permit_id) > 128
    OR p_purpose NOT IN ('query', 'chunk')
    OR p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_attempt_id IS NULL OR p_attempt_id NOT BETWEEN 1 AND 3
    OR p_consent_epoch IS NULL OR p_consent_epoch < 0
    OR p_model <> 'kinfra-text-embedding-0.6b' OR p_dimensions <> 1024
    OR p_configuration_version <> 'autoforge-knowledge-embedding-v1' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF NOT FOUND OR (permit.state <> 'issued' AND permit.state <> 'dispatching')
    OR permit.expires_at <= clock_timestamp()
    OR permit.purpose IS DISTINCT FROM p_purpose
    OR permit.request_id IS DISTINCT FROM p_request_id
    OR permit.attempt_id IS DISTINCT FROM p_attempt_id
    OR permit.consent_epoch IS DISTINCT FROM p_consent_epoch
    OR permit.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
    OR permit.generation_id IS DISTINCT FROM p_generation_id
    OR permit.chunk_id IS DISTINCT FROM p_chunk_id
    OR permit.model IS DISTINCT FROM p_model
    OR permit.dimensions IS DISTINCT FROM p_dimensions
    OR permit.configuration_version IS DISTINCT FROM p_configuration_version
    OR consent.state <> 'granted'
    OR consent.consent_epoch <> permit.consent_epoch
    OR (permit.purpose = 'query' AND consent.rebuild_required) THEN
    IF permit.permit_id IS NOT NULL
      AND permit.state IN ('issued', 'dispatching') THEN
      UPDATE public.knowledge_embedding_dispatch_permits SET
        state = CASE WHEN permit.state = 'issued' THEN 'expired' ELSE 'failed' END,
        settled_at = CASE WHEN permit.state = 'dispatching'
          THEN clock_timestamp() ELSE settled_at END
        WHERE owner_id = owner AND permit_id = permit.permit_id;
      PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
        owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
        p_knowledge_base_id, p_generation_id, p_mutation_permit, false
      );
    END IF;
    RETURN jsonb_build_object('reserved', false);
  END IF;
  IF permit.state = 'issued' THEN
    UPDATE public.knowledge_embedding_dispatch_permits SET state = 'dispatching',
      dispatching_at = clock_timestamp()
      WHERE owner_id = owner AND permit_id = permit.permit_id;
  END IF;
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  RETURN jsonb_build_object('reserved', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_mark_embedding_dispatch_started(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar,
  p_permit_id varchar, p_worker_id varchar, p_job_id varchar,
  p_lease_token varchar, p_mutation_permit varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_owner_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  permit public.knowledge_embedding_dispatch_permits%ROWTYPE;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF NOT FOUND OR permit.state <> 'dispatching'
    OR permit.expires_at <= clock_timestamp()
    OR permit.purpose IS DISTINCT FROM p_purpose
    OR permit.request_id IS DISTINCT FROM p_request_id
    OR permit.attempt_id IS DISTINCT FROM p_attempt_id
    OR permit.consent_epoch IS DISTINCT FROM p_consent_epoch
    OR permit.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
    OR permit.generation_id IS DISTINCT FROM p_generation_id
    OR permit.chunk_id IS DISTINCT FROM p_chunk_id
    OR permit.model IS DISTINCT FROM p_model
    OR permit.dimensions IS DISTINCT FROM p_dimensions
    OR permit.configuration_version IS DISTINCT FROM p_configuration_version
    OR consent.state <> 'granted'
    OR consent.consent_epoch <> permit.consent_epoch
    OR (permit.purpose = 'query' AND consent.rebuild_required) THEN
    IF permit.permit_id IS NOT NULL AND permit.state = 'dispatching' THEN
      UPDATE public.knowledge_embedding_dispatch_permits SET state = 'failed',
        settled_at = clock_timestamp()
        WHERE owner_id = owner AND permit_id = permit.permit_id;
      PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
        owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
        p_knowledge_base_id, p_generation_id, p_mutation_permit, false
      );
    END IF;
    RETURN jsonb_build_object('started', false);
  END IF;
  UPDATE public.knowledge_embedding_dispatch_permits SET state = 'started',
    started_at = clock_timestamp(), expires_at = CASE
      WHEN p_purpose = 'chunk' THEN least(
        clock_timestamp() + interval '2 minutes',
        (SELECT job.mutation_deadline_at FROM public.knowledge_jobs job
          WHERE job.id = p_job_id AND job.worker_id = p_worker_id
            AND job.lease_token = p_lease_token
            AND job.mutation_permit = p_mutation_permit)
      ) ELSE clock_timestamp() + interval '2 minutes' END
    WHERE owner_id = owner AND permit_id = permit.permit_id;
  PERFORM public.autoforge_knowledge_assert_worker_mutation_window(
    owner, p_purpose, p_consent_epoch, p_worker_id, p_job_id, p_lease_token,
    p_knowledge_base_id, p_generation_id, p_mutation_permit, false
  );
  RETURN jsonb_build_object('started', true);
END;
$$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_current_cloud_consent_revision(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_require_job_cloud_revision(bigint, varchar, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.autoforge_knowledge_require_job_cloud_revision(bigint, varchar, bigint);
DROP FUNCTION IF EXISTS public.autoforge_knowledge_current_cloud_consent_revision(bigint);

COMMIT;
