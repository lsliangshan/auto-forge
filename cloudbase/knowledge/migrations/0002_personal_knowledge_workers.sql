BEGIN;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_begin_generation(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_name varchar, p_revision varchar, p_generation_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  request_row public.knowledge_requests%ROWTYPE;
  base public.knowledge_bases%ROWTYPE;
  generation public.knowledge_index_generations%ROWTYPE;
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'begin_generation', 'knowledgeBaseId', p_knowledge_base_id,
    'name', p_name, 'revision', p_revision, 'generationId', p_generation_id
  ));
  response jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_knowledge_base_id IS NULL OR btrim(p_knowledge_base_id) = ''
    OR length(p_knowledge_base_id) > 128
    OR p_name IS NULL OR btrim(p_name) = '' OR btrim(p_name) <> p_name
    OR length(p_name) > 200
    OR p_revision IS NULL OR btrim(p_revision) = '' OR length(p_revision) > 128
    OR p_generation_id IS NULL OR btrim(p_generation_id) = ''
    OR length(p_generation_id) > 128 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF request_row.action <> 'begin_generation' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT * INTO base FROM public.knowledge_bases
    WHERE owner_id = owner AND id = p_knowledge_base_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.knowledge_bases(
      id, owner_id, name, status, revision
    ) VALUES (p_knowledge_base_id, owner, p_name, 'staging', p_revision)
    RETURNING * INTO base;
  ELSIF base.status IN ('deleting', 'deleted') OR base.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  ELSE
    UPDATE public.knowledge_bases SET name = p_name, revision = p_revision,
      updated_at = clock_timestamp()
      WHERE owner_id = owner AND id = p_knowledge_base_id
      RETURNING * INTO base;
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.knowledge_index_generations(
      id, owner_id, knowledge_base_id, status, configuration
    ) VALUES (
      p_generation_id, owner, p_knowledge_base_id, 'staging',
      '{"distance":"cosine","normalization":"none","region":"guangzhou"}'::jsonb
    ) RETURNING * INTO generation;
  ELSIF generation.status <> 'staging' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  response := jsonb_build_object(
    'knowledgeBaseId', p_knowledge_base_id,
    'generationId', p_generation_id,
    'status', 'staging'
  );
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (
    owner, p_request_id, p_knowledge_base_id, 'begin_generation', fingerprint, response
  );
  RETURN response;
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

REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_generation(
  varchar, varchar, varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_upload_work(
  varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_upload_index(
  varchar, varchar, varchar, bigint, varchar, varchar, varchar, varchar,
  varchar, varchar, varchar, integer, varchar, varchar, jsonb, jsonb, varchar
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_yield_job(
  varchar, varchar, varchar, varchar
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_begin_generation(
  varchar, varchar, varchar, varchar, varchar, varchar
) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_upload_work(
  varchar, varchar, varchar
) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_upload_index(
  varchar, varchar, varchar, bigint, varchar, varchar, varchar, varchar,
  varchar, varchar, varchar, integer, varchar, varchar, jsonb, jsonb, varchar
) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_yield_job(
  varchar, varchar, varchar, varchar
) TO service_role;

COMMIT;
