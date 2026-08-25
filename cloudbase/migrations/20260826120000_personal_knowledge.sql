BEGIN;

CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'ready', 'paused', 'deleting', 'deleted')),
  published_generation_id varchar(128),
  revision varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_bases_owner_updated
  ON public.knowledge_bases(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_objects (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  storage_reference varchar(512) NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state varchar(32) NOT NULL CHECK (state IN ('authorized', 'uploaded', 'verified', 'orphaned', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_objects_owner_base
  ON public.knowledge_objects(owner_id, knowledge_base_id, created_at);

CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  name varchar(500) NOT NULL,
  mime_type varchar(200) NOT NULL,
  active_version_id varchar(128),
  revision varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_documents_owner_base
  ON public.knowledge_documents(owner_id, knowledge_base_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_versions (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  document_id varchar(128) NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  source_object_id varchar(128) REFERENCES public.knowledge_objects(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  UNIQUE(document_id, version_number)
);
CREATE INDEX IF NOT EXISTS knowledge_versions_owner_document
  ON public.knowledge_versions(owner_id, document_id, version_number DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_parser_runs (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  version_id varchar(128) NOT NULL REFERENCES public.knowledge_versions(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  parser_version varchar(128) NOT NULL,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.knowledge_blocks (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  version_id varchar(128) NOT NULL REFERENCES public.knowledge_versions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind varchar(64) NOT NULL,
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  document_id varchar(128) NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  version_id varchar(128) NOT NULL REFERENCES public.knowledge_versions(id) ON DELETE CASCADE,
  block_id varchar(128) NOT NULL REFERENCES public.knowledge_blocks(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version_id, ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_owner_base_version
  ON public.knowledge_chunks(owner_id, knowledge_base_id, version_id);

CREATE TABLE IF NOT EXISTS public.knowledge_index_generations (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'published', 'failed', 'retired')),
  model varchar(128),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  published_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_one_published_generation
  ON public.knowledge_index_generations(knowledge_base_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS public.knowledge_jobs (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  request_id varchar(128) NOT NULL,
  kind varchar(64) NOT NULL,
  entity_id varchar(128) NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  lease_token varchar(128),
  lease_expires_at timestamptz,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, request_id)
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_claim
  ON public.knowledge_jobs(state, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS public.knowledge_entity_heads (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  entity_kind varchar(32) NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
  entity_id varchar(128) NOT NULL,
  revision varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, entity_kind, entity_id)
);

CREATE TABLE IF NOT EXISTS public.knowledge_changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  mutation_id varchar(128) NOT NULL,
  input_hash char(32) NOT NULL,
  entity_kind varchar(32) NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
  entity_id varchar(128) NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('upsert', 'delete')),
  revision varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, mutation_id)
);
CREATE INDEX IF NOT EXISTS knowledge_changes_owner_sequence
  ON public.knowledge_changes(owner_id, knowledge_base_id, sequence);

CREATE TABLE IF NOT EXISTS public.knowledge_tombstones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  entity_kind varchar(32) NOT NULL,
  entity_id varchar(128) NOT NULL,
  revision varchar(128) NOT NULL,
  sequence bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  UNIQUE(owner_id, knowledge_base_id, entity_kind, entity_id, revision)
);
CREATE INDEX IF NOT EXISTS knowledge_tombstones_expiry
  ON public.knowledge_tombstones(expires_at);

CREATE TABLE IF NOT EXISTS public.knowledge_conflicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  mutation_id varchar(128) NOT NULL,
  entity_kind varchar(32) NOT NULL,
  entity_id varchar(128) NOT NULL,
  conflict_kind varchar(32) NOT NULL CHECK (conflict_kind IN ('content', 'delete_vs_update')),
  local_revision varchar(128) NOT NULL,
  remote_revision varchar(128) NOT NULL,
  local_payload jsonb NOT NULL,
  remote_payload jsonb NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(owner_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS public.knowledge_entitlements (
  owner_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier varchar(16) NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'member')),
  status varchar(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'offline_grace', 'expired', 'unavailable')),
  beta_enabled boolean NOT NULL DEFAULT false,
  cloud_enabled boolean NOT NULL DEFAULT false,
  kill_switch_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  valid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.knowledge_requests (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id varchar(128) NOT NULL,
  action varchar(64) NOT NULL,
  input_hash char(32) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, request_id)
);

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_version_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.knowledge_base_id IS DISTINCT FROM OLD.knowledge_base_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.source_object_id IS DISTINCT FROM OLD.source_object_id
    OR NEW.version_number IS DISTINCT FROM OLD.version_number
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS knowledge_versions_lifecycle ON public.knowledge_versions;
CREATE TRIGGER knowledge_versions_lifecycle
BEFORE UPDATE ON public.knowledge_versions
FOR EACH ROW EXECUTE FUNCTION public.autoforge_knowledge_version_lifecycle();

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_generation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.knowledge_base_id IS DISTINCT FROM OLD.knowledge_base_id
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.configuration IS DISTINCT FROM OLD.configuration
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'published')
      OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS knowledge_generations_lifecycle ON public.knowledge_index_generations;
CREATE TRIGGER knowledge_generations_lifecycle
BEFORE UPDATE ON public.knowledge_index_generations
FOR EACH ROW EXECUTE FUNCTION public.autoforge_knowledge_generation_lifecycle();

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
END;
$$;
DROP TRIGGER IF EXISTS knowledge_changes_immutable ON public.knowledge_changes;
CREATE TRIGGER knowledge_changes_immutable
BEFORE UPDATE ON public.knowledge_changes
FOR EACH ROW EXECUTE FUNCTION public.autoforge_knowledge_reject_mutation();

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_request_user_id()
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  claims jsonb;
  user_text text;
BEGIN
  BEGIN
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  user_text := COALESCE(claims->>'sub', claims->>'uid');
  IF user_text IS NULL OR user_text !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  RETURN user_text::bigint;
END;
$$;

-- All knowledge rows carry owner_id so every direct-table path has the same fail-closed predicate.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
    'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks',
    'knowledge_index_generations', 'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_entitlements', 'knowledge_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS knowledge_owner_isolation ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY knowledge_owner_isolation ON public.%I USING (owner_id = public.autoforge_knowledge_request_user_id()) WITH CHECK (owner_id = public.autoforge_knowledge_request_user_id())',
      table_name
    );
  END LOOP;
END;
$rls$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_caller(p_caller_user_id varchar)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE result bigint;
BEGIN
  IF p_caller_user_id IS NULL OR p_caller_user_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001';
  END IF;
  SELECT id INTO result FROM auth.users WHERE id::text = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'AUTH_REQUIRED', ERRCODE = 'P0001'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_require_cloud(p_owner_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE entitlement public.knowledge_entitlements%ROWTYPE;
BEGIN
  SELECT * INTO entitlement FROM public.knowledge_entitlements WHERE owner_id = p_owner_id;
  IF NOT FOUND OR entitlement.kill_switch_enabled THEN
    RAISE EXCEPTION USING MESSAGE = 'KILL_SWITCH_ENABLED', ERRCODE = 'P0001';
  END IF;
  IF entitlement.tier <> 'member' OR NOT entitlement.cloud_enabled
    OR entitlement.status NOT IN ('active', 'offline_grace') THEN
    RAISE EXCEPTION USING MESSAGE = 'ENTITLEMENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_begin_sync(
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
  fingerprint char(32) := md5(concat_ws(':', p_knowledge_base_id, p_name, p_revision, p_generation_id));
  response jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'begin_sync' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  IF EXISTS (SELECT 1 FROM public.knowledge_bases WHERE id = p_knowledge_base_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.knowledge_bases(
    id, owner_id, name, status, revision
  ) VALUES (p_knowledge_base_id, owner, p_name, 'staging', p_revision);
  INSERT INTO public.knowledge_index_generations(
    id, owner_id, knowledge_base_id, status, configuration
  ) VALUES (p_generation_id, owner, p_knowledge_base_id, 'staging', '{}'::jsonb);
  response := jsonb_build_object(
    'knowledgeBaseId', p_knowledge_base_id,
    'generationId', p_generation_id,
    'status', 'staging'
  );
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'begin_sync', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_authorize_upload(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_document_id varchar, p_version_id varchar, p_byte_size bigint, p_sha256 varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := md5(concat_ws(
    ':', p_knowledge_base_id, p_document_id, p_version_id, p_byte_size::text, p_sha256
  ));
  response jsonb;
  object_id varchar := 'object_' || md5(p_request_id || ':' || p_version_id);
  job_id varchar := 'job_' || md5(p_request_id || ':upload');
  storage_ref varchar;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
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
    id, owner_id, knowledge_base_id, storage_reference, byte_size, sha256, state
  ) VALUES (object_id, owner, p_knowledge_base_id, storage_ref, p_byte_size, p_sha256, 'authorized');
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (job_id, owner, p_knowledge_base_id, p_request_id, 'upload', p_version_id, 'queued');
  response := jsonb_build_object(
    'uploadTicket', p_request_id, 'storageReference', storage_ref,
    'objectId', object_id, 'jobId', job_id, 'expiresAt',
    to_char((clock_timestamp() + interval '15 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'authorize_upload', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_push_mutation(
  p_caller_user_id varchar, p_mutation_id varchar, p_knowledge_base_id varchar,
  p_entity_kind varchar, p_entity_id varchar, p_operation varchar,
  p_base_revision varchar, p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  head public.knowledge_entity_heads%ROWTYPE;
  existing public.knowledge_changes%ROWTYPE;
  next_sequence bigint;
  next_revision varchar := p_mutation_id;
  conflict_kind varchar;
  fingerprint char(32) := md5(concat_ws(
    ':', p_knowledge_base_id, p_entity_kind, p_entity_id, p_operation,
    COALESCE(p_base_revision, ''), p_payload::text
  ));
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_mutation_id, 0));
  SELECT * INTO existing FROM public.knowledge_changes
    WHERE owner_id = owner AND mutation_id = p_mutation_id;
  IF FOUND THEN
    IF existing.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'mutationId', p_mutation_id, 'status', 'duplicate',
      'sequence', existing.sequence, 'revision', existing.revision
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner AND deleted_at IS NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(
    ':', owner::text, p_knowledge_base_id, p_entity_kind, p_entity_id
  ), 0));
  SELECT * INTO head FROM public.knowledge_entity_heads
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND entity_kind = p_entity_kind AND entity_id = p_entity_id FOR UPDATE;
  IF FOUND AND p_entity_kind <> 'metadata' AND p_base_revision IS DISTINCT FROM head.revision THEN
    conflict_kind := CASE WHEN p_operation = 'delete' AND NOT head.deleted
      THEN 'delete_vs_update' ELSE 'content' END;
    INSERT INTO public.knowledge_conflicts(
      owner_id, knowledge_base_id, mutation_id, entity_kind, entity_id, conflict_kind,
      local_revision, remote_revision, local_payload, remote_payload
    ) VALUES (
      owner, p_knowledge_base_id, p_mutation_id, p_entity_kind, p_entity_id, conflict_kind,
      COALESCE(p_base_revision, p_mutation_id), head.revision, p_payload, head.payload
    );
    RETURN jsonb_build_object(
      'mutationId', p_mutation_id, 'status', 'conflict', 'conflictKind', conflict_kind,
      'localRevision', COALESCE(p_base_revision, p_mutation_id),
      'remoteRevision', head.revision,
      'sequence', COALESCE((SELECT max(sequence) FROM public.knowledge_changes
        WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0)
    );
  END IF;
  INSERT INTO public.knowledge_entity_heads(
    owner_id, knowledge_base_id, entity_kind, entity_id, revision, payload, deleted, updated_at
  ) VALUES (
    owner, p_knowledge_base_id, p_entity_kind, p_entity_id, next_revision, p_payload,
    p_operation = 'delete', clock_timestamp()
  ) ON CONFLICT(owner_id, knowledge_base_id, entity_kind, entity_id) DO UPDATE SET
    revision = excluded.revision, payload = excluded.payload, deleted = excluded.deleted,
    updated_at = excluded.updated_at;
  INSERT INTO public.knowledge_changes(
    owner_id, knowledge_base_id, mutation_id, input_hash,
    entity_kind, entity_id, operation, revision, payload
  ) VALUES (
    owner, p_knowledge_base_id, p_mutation_id, fingerprint, p_entity_kind, p_entity_id,
    p_operation, next_revision, p_payload
  ) RETURNING sequence INTO next_sequence;
  IF p_operation = 'delete' THEN
    INSERT INTO public.knowledge_tombstones(
      owner_id, knowledge_base_id, entity_kind, entity_id, revision, sequence
    ) VALUES (owner, p_knowledge_base_id, p_entity_kind, p_entity_id, next_revision, next_sequence);
  END IF;
  RETURN jsonb_build_object(
    'mutationId', p_mutation_id, 'status', 'applied',
    'sequence', next_sequence, 'revision', next_revision
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_pull_changes(
  p_caller_user_id varchar, p_knowledge_base_id varchar,
  p_after_sequence bigint, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  earliest bigint;
  latest bigint;
  changes jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  SELECT min(sequence), max(sequence) INTO earliest, latest FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND created_at >= clock_timestamp() - interval '90 days';
  -- CURSOR_STALE is represented as a typed result so clients can start full resync without parsing errors.
  IF p_after_sequence > 0 AND earliest IS NOT NULL AND p_after_sequence < earliest - 1 THEN
    RETURN jsonb_build_object('kind', 'cursor_stale');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sequence', sequence, 'entityKind', entity_kind, 'entityId', entity_id,
    'operation', operation, 'revision', revision, 'payload', payload
  ) ORDER BY sequence), '[]'::jsonb) INTO changes
  FROM (SELECT * FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND sequence > p_after_sequence ORDER BY sequence LIMIT p_limit) selected;
  RETURN jsonb_build_object(
    'kind', 'incremental', 'nextSequence', greatest(COALESCE(latest, 0), p_after_sequence),
    'changes', changes
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_full_resync(
  p_caller_user_id varchar, p_knowledge_base_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  latest bigint;
  changes jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(max(sequence), 0) INTO latest FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sequence', latest, 'entityKind', entity_kind, 'entityId', entity_id,
    'operation', CASE WHEN deleted THEN 'delete' ELSE 'upsert' END,
    'revision', revision, 'payload', payload
  ) ORDER BY entity_kind, entity_id), '[]'::jsonb) INTO changes
  FROM public.knowledge_entity_heads
  WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id;
  RETURN jsonb_build_object('kind', 'incremental', 'nextSequence', latest, 'changes', changes);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_publish_generation(
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
  generation public.knowledge_index_generations%ROWTYPE;
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := md5(concat_ws(
    ':', p_knowledge_base_id, p_generation_id, COALESCE(p_expected_published_generation_id, '')
  ));
  response jsonb;
  next_sequence bigint;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'publish_generation' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT * INTO base FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  IF base.published_generation_id IS DISTINCT FROM p_expected_published_generation_id THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE id = p_generation_id AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id FOR UPDATE;
  IF NOT FOUND OR generation.status <> 'ready' THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_index_generations SET status = 'retired'
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id AND status = 'published';
  UPDATE public.knowledge_index_generations SET status = 'published', published_at = clock_timestamp()
    WHERE id = p_generation_id;
  UPDATE public.knowledge_bases SET published_generation_id = p_generation_id,
    status = 'ready', revision = p_request_id, updated_at = clock_timestamp()
    WHERE id = p_knowledge_base_id;
  INSERT INTO public.knowledge_changes(
    owner_id, knowledge_base_id, mutation_id, input_hash, entity_kind, entity_id,
    operation, revision, payload
  ) VALUES (
    owner, p_knowledge_base_id, p_request_id, fingerprint, 'knowledge_base', p_knowledge_base_id,
    'upsert', p_request_id, jsonb_build_object('publishedGenerationId', p_generation_id)
  ) RETURNING sequence INTO next_sequence;
  response := jsonb_build_object(
    'generationId', p_generation_id,
    'previousGenerationId', base.published_generation_id,
    'sequence', next_sequence
  );
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'publish_generation', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_delete_base(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_expected_published_generation_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  base public.knowledge_bases%ROWTYPE;
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := md5(concat_ws(
    ':', p_knowledge_base_id, COALESCE(p_expected_published_generation_id, '')
  ));
  response jsonb;
  job_id varchar := 'job_' || md5(p_request_id || ':delete');
  next_sequence bigint;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'delete_base' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT * INTO base FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  IF base.published_generation_id IS DISTINCT FROM p_expected_published_generation_id THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_bases SET status = 'deleting', deleted_at = clock_timestamp(),
    revision = p_request_id, updated_at = clock_timestamp() WHERE id = p_knowledge_base_id;
  INSERT INTO public.knowledge_changes(
    owner_id, knowledge_base_id, mutation_id, input_hash, entity_kind, entity_id,
    operation, revision, payload
  ) VALUES (
    owner, p_knowledge_base_id, p_request_id, fingerprint, 'knowledge_base', p_knowledge_base_id,
    'delete', p_request_id, '{}'::jsonb
  ) RETURNING sequence INTO next_sequence;
  INSERT INTO public.knowledge_tombstones(
    owner_id, knowledge_base_id, entity_kind, entity_id, revision, sequence
  ) VALUES (owner, p_knowledge_base_id, 'knowledge_base', p_knowledge_base_id, p_request_id, next_sequence);
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (job_id, owner, p_knowledge_base_id, p_request_id, 'purge', p_knowledge_base_id, 'queued');
  response := jsonb_build_object('deletionJobId', job_id);
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'delete_base', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cancel_job(
  p_caller_user_id varchar, p_request_id varchar, p_job_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  changed integer;
BEGIN
  UPDATE public.knowledge_jobs SET state = 'cancelled', lease_token = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE id = p_job_id AND owner_id = owner AND state IN ('queued', 'running', 'paused');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN jsonb_build_object('cancelled', changed = 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cleanup_orphans(
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
  removed integer;
BEGIN
  DELETE FROM public.knowledge_objects object
    WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
      AND object.state IN ('authorized', 'orphaned')
      AND object.storage_reference IN (SELECT jsonb_array_elements_text(p_storage_references))
      AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
        WHERE version.source_object_id = object.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN jsonb_build_object('removed', removed);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_get_entitlement(p_caller_user_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  entitlement public.knowledge_entitlements%ROWTYPE;
BEGIN
  INSERT INTO public.knowledge_entitlements(owner_id) VALUES (owner) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT entitlement FROM public.knowledge_entitlements WHERE owner_id = owner;
  RETURN jsonb_build_object(
    'tier', entitlement.tier, 'status', entitlement.status,
    'betaEnabled', entitlement.beta_enabled, 'cloudEnabled', entitlement.cloud_enabled,
    'killSwitchEnabled', entitlement.kill_switch_enabled,
    'version', entitlement.version, 'validUntil', CASE
      WHEN entitlement.valid_until IS NULL THEN NULL
      ELSE to_char(
        entitlement.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    END
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
  IF p_worker_id IS NULL OR p_lease_token IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE attempt < 3 AND (
      state = 'queued' OR (state = 'running' AND lease_expires_at <= clock_timestamp())
    ) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('job', NULL); END IF;
  UPDATE public.knowledge_jobs SET state = 'running', attempt = attempt + 1,
    lease_token = p_lease_token,
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    updated_at = clock_timestamp() WHERE id = job.id;
  RETURN jsonb_build_object('job', jsonb_build_object(
    'id', job.id, 'kind', job.kind, 'entityId', job.entity_id,
    'leaseToken', p_lease_token, 'attempt', job.attempt + 1
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_job(
  p_job_id varchar, p_lease_token varchar, p_state varchar, p_error_code varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed integer;
BEGIN
  IF p_state NOT IN ('completed', 'failed', 'queued') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_jobs SET state = p_state, error_code = p_error_code,
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE id = p_job_id AND state = 'running' AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
      AND (p_state <> 'queued' OR attempt < 3);
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('completed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_request_user_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_version_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_generation_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_reject_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_caller(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_require_cloud(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_orphans(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;

DO $grants$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
    'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks',
    'knowledge_index_generations', 'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_entitlements', 'knowledge_requests'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$grants$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cleanup_orphans(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar) TO service_role;

COMMIT;
