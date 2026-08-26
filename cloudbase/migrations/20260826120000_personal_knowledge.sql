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
  deleted_at timestamptz,
  UNIQUE(owner_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_bases_owner_updated
  ON public.knowledge_bases(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_objects (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  storage_reference varchar(512) NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state varchar(32) NOT NULL CHECK (state IN (
    'authorized', 'uploaded', 'verified', 'orphaned', 'cleanup_reserved', 'deleted'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  cleanup_request_id varchar(128),
  cleanup_reserved_at timestamptz,
  deleted_at timestamptz,
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_objects_owner_base
  ON public.knowledge_objects(owner_id, knowledge_base_id, created_at);

CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  name varchar(500) NOT NULL,
  mime_type varchar(200) NOT NULL,
  active_version_id varchar(128),
  revision varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_documents_owner_base
  ON public.knowledge_documents(owner_id, knowledge_base_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_versions (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  document_id varchar(128) NOT NULL,
  source_object_id varchar(128),
  version_number integer NOT NULL CHECK (version_number > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  UNIQUE(owner_id, knowledge_base_id, id),
  UNIQUE(owner_id, knowledge_base_id, document_id, id),
  UNIQUE(owner_id, knowledge_base_id, document_id, version_number),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, document_id)
    REFERENCES public.knowledge_documents(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, source_object_id)
    REFERENCES public.knowledge_objects(owner_id, knowledge_base_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS knowledge_versions_owner_document
  ON public.knowledge_versions(owner_id, document_id, version_number DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_parser_runs (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  parser_version varchar(128) NOT NULL,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_blocks (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind varchar(64) NOT NULL,
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, knowledge_base_id, id),
  UNIQUE(owner_id, knowledge_base_id, version_id, id),
  UNIQUE(owner_id, knowledge_base_id, version_id, ordinal),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  document_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  block_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, knowledge_base_id, id),
  UNIQUE(owner_id, knowledge_base_id, version_id, ordinal),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, document_id)
    REFERENCES public.knowledge_documents(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, document_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)
      ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id, block_id)
    REFERENCES public.knowledge_blocks(owner_id, knowledge_base_id, version_id, id)
      ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_owner_base_version
  ON public.knowledge_chunks(owner_id, knowledge_base_id, version_id);

CREATE TABLE IF NOT EXISTS public.knowledge_index_generations (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'published', 'failed', 'retired')),
  model varchar(128),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  probe_fingerprint char(64) CHECK (
    probe_fingerprint IS NULL OR probe_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  retain_until timestamptz,
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_one_published_generation
  ON public.knowledge_index_generations(knowledge_base_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS public.knowledge_embedding_consents (
  owner_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'granted', 'denied', 'revoked')),
  authorization_epoch bigint NOT NULL DEFAULT 0 CHECK (authorization_epoch >= 0),
  processor varchar(32) NOT NULL DEFAULT 'tokenhub' CHECK (processor = 'tokenhub'),
  processing_region varchar(32) NOT NULL DEFAULT 'Guangzhou'
    CHECK (processing_region = 'Guangzhou'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.knowledge_embedding_consents
  ADD COLUMN IF NOT EXISTS authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0);

CREATE TABLE IF NOT EXISTS public.knowledge_embedding_send_leases (
  lease_token varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES public.knowledge_embedding_consents(owner_id)
    ON DELETE CASCADE,
  consent_epoch bigint NOT NULL CHECK (consent_epoch >= 0),
  purpose varchar(16) NOT NULL CHECK (purpose IN ('query', 'index', 'drift')),
  state varchar(16) NOT NULL DEFAULT 'admitted'
    CHECK (state IN ('admitted', 'sending', 'released', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, lease_token)
);
ALTER TABLE public.knowledge_embedding_send_leases
  ADD COLUMN IF NOT EXISTS state varchar(16) NOT NULL DEFAULT 'admitted'
    CHECK (state IN ('admitted', 'sending', 'released', 'expired')),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DROP INDEX IF EXISTS public.knowledge_embedding_send_leases_owner_epoch;
CREATE INDEX IF NOT EXISTS knowledge_embedding_send_leases_owner_epoch
  ON public.knowledge_embedding_send_leases(owner_id, consent_epoch, state, expires_at);

CREATE TABLE IF NOT EXISTS public.knowledge_generation_chunks (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  generation_id varchar(128) NOT NULL,
  chunk_id varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, generation_id, chunk_id),
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id)
    REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id)
      ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, chunk_id)
    REFERENCES public.knowledge_chunks(owner_id, knowledge_base_id, id)
      ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_chunk_embeddings (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  generation_id varchar(128) NOT NULL,
  chunk_id varchar(128) NOT NULL,
  model varchar(128) NOT NULL CHECK (model = 'kinfra-text-embedding-0.6b'),
  dimensions integer NOT NULL DEFAULT 1024 CHECK (dimensions = 1024),
  embedding double precision[] NOT NULL CHECK (array_length(embedding, 1) = 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, generation_id, chunk_id),
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id, chunk_id)
    REFERENCES public.knowledge_generation_chunks(
      owner_id, knowledge_base_id, generation_id, chunk_id
    ) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunk_embeddings_generation
  ON public.knowledge_chunk_embeddings(owner_id, knowledge_base_id, generation_id);

-- Backfill published generation keyword mappings before retrieval starts using them.
INSERT INTO public.knowledge_generation_chunks(
  owner_id, knowledge_base_id, generation_id, chunk_id
)
SELECT base.owner_id, base.id, base.published_generation_id, chunk.id
FROM public.knowledge_bases base
JOIN public.knowledge_index_generations generation
  ON generation.owner_id = base.owner_id
    AND generation.knowledge_base_id = base.id
    AND generation.id = base.published_generation_id
    AND generation.status = 'published'
JOIN public.knowledge_documents document
  ON document.owner_id = base.owner_id AND document.knowledge_base_id = base.id
    AND document.status = 'ready' AND document.deleted_at IS NULL
JOIN public.knowledge_versions version
  ON version.owner_id = base.owner_id AND version.knowledge_base_id = base.id
    AND version.document_id = document.id AND version.id = document.active_version_id
    AND version.status = 'ready'
JOIN public.knowledge_chunks chunk
  ON chunk.owner_id = base.owner_id AND chunk.knowledge_base_id = base.id
    AND chunk.document_id = document.id AND chunk.version_id = version.id
WHERE base.published_generation_id IS NOT NULL AND base.deleted_at IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE public.knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_active_version_owner_fk,
  ADD CONSTRAINT knowledge_documents_active_version_owner_fk
  FOREIGN KEY(owner_id, knowledge_base_id, id, active_version_id)
  REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, document_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.knowledge_bases
  DROP CONSTRAINT IF EXISTS knowledge_bases_published_generation_owner_fk,
  ADD CONSTRAINT knowledge_bases_published_generation_owner_fk
  FOREIGN KEY(owner_id, id, published_generation_id)
  REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS public.knowledge_jobs (
  id varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
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
  UNIQUE(owner_id, request_id),
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_claim
  ON public.knowledge_jobs(state, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS public.knowledge_entity_heads (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  entity_kind varchar(32) NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
  entity_id varchar(128) NOT NULL,
  revision varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, entity_kind, entity_id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  input_hash char(32) NOT NULL,
  entity_kind varchar(32) NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
  entity_id varchar(128) NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('upsert', 'delete')),
  revision varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, mutation_id),
  UNIQUE(owner_id, knowledge_base_id, sequence),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_changes_owner_sequence
  ON public.knowledge_changes(owner_id, knowledge_base_id, sequence);

CREATE TABLE IF NOT EXISTS public.knowledge_tombstones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  entity_kind varchar(32) NOT NULL,
  entity_id varchar(128) NOT NULL,
  revision varchar(128) NOT NULL,
  sequence bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  UNIQUE(owner_id, knowledge_base_id, entity_kind, entity_id, revision),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, sequence)
    REFERENCES public.knowledge_changes(owner_id, knowledge_base_id, sequence) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_tombstones_expiry
  ON public.knowledge_tombstones(expires_at);

CREATE TABLE IF NOT EXISTS public.knowledge_conflicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  entity_kind varchar(32) NOT NULL,
  entity_id varchar(128) NOT NULL,
  conflict_kind varchar(32) NOT NULL CHECK (conflict_kind IN ('content', 'delete_vs_update')),
  local_revision varchar(128) NOT NULL,
  remote_revision varchar(128) NOT NULL,
  local_payload jsonb NOT NULL,
  remote_payload jsonb NOT NULL,
  input_hash char(32) NOT NULL,
  response jsonb NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(owner_id, mutation_id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_sync_floors (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  minimum_sequence bigint NOT NULL CHECK (minimum_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_upload_authorizations (
  upload_ticket varchar(128) PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  object_id varchar(128) NOT NULL,
  expected_byte_size bigint NOT NULL CHECK (expected_byte_size > 0),
  expected_sha256 char(64) NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, knowledge_base_id, upload_ticket),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, object_id)
    REFERENCES public.knowledge_objects(owner_id, knowledge_base_id, id) ON DELETE CASCADE
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
    OR ((NEW.model IS DISTINCT FROM OLD.model
      OR NEW.configuration IS DISTINCT FROM OLD.configuration)
      AND NOT (OLD.status = 'staging' AND NEW.status = 'staging'))
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR ((NEW.retired_at IS DISTINCT FROM OLD.retired_at
      OR NEW.retain_until IS DISTINCT FROM OLD.retain_until)
      AND NOT (OLD.status = 'published' AND NEW.status = 'retired'))
    OR NOT ((OLD.status = 'staging' AND NEW.status IN ('staging', 'ready', 'failed'))
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
    'knowledge_index_generations', 'knowledge_embedding_consents',
    'knowledge_embedding_send_leases',
    'knowledge_generation_chunks', 'knowledge_chunk_embeddings',
    'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_sync_floors', 'knowledge_upload_authorizations',
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
  upload_ticket varchar := 'upload_' || md5(
    owner::text || ':' || p_request_id || ':' || clock_timestamp()::text
  );
  authorization_expires_at timestamptz := clock_timestamp() + interval '15 minutes';
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
  INSERT INTO public.knowledge_upload_authorizations(
    upload_ticket, owner_id, knowledge_base_id, object_id,
    expected_byte_size, expected_sha256, expires_at
  ) VALUES (
    upload_ticket, owner, p_knowledge_base_id, object_id,
    p_byte_size, p_sha256, authorization_expires_at
  );
  response := jsonb_build_object(
    'uploadTicket', upload_ticket, 'storageReference', storage_ref,
    'objectId', object_id, 'jobId', job_id, 'expiresAt',
    to_char(authorization_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'authorize_upload', fingerprint, response);
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
    'objectId', object.id, 'storageReference', object.storage_reference,
    'expectedByteSize', authorization.expected_byte_size,
    'expectedSha256', authorization.expected_sha256
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_verify_upload(
  p_caller_user_id varchar, p_upload_ticket varchar,
  p_actual_byte_size bigint, p_actual_sha256 varchar
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
  IF authorization.consumed_at IS NOT NULL OR authorization.expires_at <= clock_timestamp()
    OR authorization.expected_byte_size <> p_actual_byte_size
    OR authorization.expected_sha256 <> p_actual_sha256 THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_upload_authorizations SET consumed_at = clock_timestamp()
    WHERE upload_ticket = p_upload_ticket;
  UPDATE public.knowledge_objects AS object
    SET state = 'verified', verified_at = clock_timestamp()
    WHERE object.id = authorization.object_id AND object.owner_id = owner
      AND object.knowledge_base_id = authorization.knowledge_base_id
      AND object.state IN ('authorized', 'uploaded')
    RETURNING * INTO object;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'objectId', object.id, 'storageReference', object.storage_reference, 'verified', true
  );
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
  existing_conflict public.knowledge_conflicts%ROWTYPE;
  next_sequence bigint;
  next_revision varchar := p_mutation_id;
  conflict_kind varchar;
  response jsonb;
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
  SELECT * INTO existing_conflict FROM public.knowledge_conflicts
    WHERE owner_id = owner AND mutation_id = p_mutation_id;
  IF FOUND THEN
    IF existing_conflict.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN existing_conflict.response;
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
    response := jsonb_build_object(
      'mutationId', p_mutation_id, 'status', 'conflict', 'conflictKind', conflict_kind,
      'localRevision', COALESCE(p_base_revision, p_mutation_id),
      'remoteRevision', head.revision,
      'sequence', COALESCE((SELECT max(sequence) FROM public.knowledge_changes
        WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0)
    );
    INSERT INTO public.knowledge_conflicts(
      owner_id, knowledge_base_id, mutation_id, entity_kind, entity_id, conflict_kind,
      local_revision, remote_revision, local_payload, remote_payload, input_hash, response
    ) VALUES (
      owner, p_knowledge_base_id, p_mutation_id, p_entity_kind, p_entity_id, conflict_kind,
      COALESCE(p_base_revision, p_mutation_id), head.revision, p_payload, head.payload,
      fingerprint, response
    );
    RETURN response;
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
  retention_floor bigint := 0;
  page_last_sequence bigint;
  has_more boolean;
  changes jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  SELECT minimum_sequence INTO retention_floor FROM public.knowledge_sync_floors
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id;
  retention_floor := COALESCE(retention_floor, 0);
  -- A new client and every cursor below the durable retention floor use an atomic snapshot.
  IF p_after_sequence = 0
    OR (retention_floor > 0 AND p_after_sequence < retention_floor - 1)
    OR (p_after_sequence > 0 AND retention_floor = 0 AND NOT EXISTS (
      SELECT 1 FROM public.knowledge_changes
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
    )) THEN
    RETURN jsonb_build_object('kind', 'cursor_stale');
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sequence', sequence, 'entityKind', entity_kind, 'entityId', entity_id,
    'operation', operation, 'revision', revision, 'payload', payload
  ) ORDER BY sequence), '[]'::jsonb) INTO changes
  FROM (SELECT * FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND sequence > p_after_sequence ORDER BY sequence LIMIT p_limit) selected;
  SELECT COALESCE(max(sequence), p_after_sequence) INTO page_last_sequence
    FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND sequence > p_after_sequence
      AND sequence IN (
        SELECT sequence FROM public.knowledge_changes
        WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
          AND sequence > p_after_sequence ORDER BY sequence LIMIT p_limit
      );
  SELECT EXISTS(
    SELECT 1 FROM public.knowledge_changes
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND sequence > page_last_sequence
  ) INTO has_more;
  RETURN jsonb_build_object(
    'kind', 'incremental', 'nextSequence', page_last_sequence,
    'hasMore', has_more, 'changes', changes
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
  SELECT greatest(
    COALESCE((SELECT max(sequence) FROM public.knowledge_changes
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0),
    COALESCE((SELECT minimum_sequence - 1 FROM public.knowledge_sync_floors
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0)
  ) INTO latest;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sequence', latest, 'entityKind', entity_kind, 'entityId', entity_id,
    'operation', CASE WHEN deleted THEN 'delete' ELSE 'upsert' END,
    'revision', revision, 'payload', payload
  ) ORDER BY entity_kind, entity_id), '[]'::jsonb) INTO changes
  FROM public.knowledge_entity_heads
  WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id;
  RETURN jsonb_build_object('kind', 'snapshot', 'nextSequence', latest, 'changes', changes);
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
  IF EXISTS (
    SELECT 1 FROM public.knowledge_objects
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND deleted_at IS NULL AND verified_at IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.knowledge_generation_chunks(
    owner_id, knowledge_base_id, generation_id, chunk_id
  )
  SELECT owner, p_knowledge_base_id, p_generation_id, chunk.id
  FROM public.knowledge_documents document
  JOIN public.knowledge_versions version
    ON version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
      AND version.document_id = document.id AND version.id = document.active_version_id
      AND version.status = 'ready'
  JOIN public.knowledge_chunks chunk
    ON chunk.owner_id = owner AND chunk.knowledge_base_id = p_knowledge_base_id
      AND chunk.document_id = document.id AND chunk.version_id = version.id
  WHERE document.owner_id = owner AND document.knowledge_base_id = p_knowledge_base_id
    AND document.status = 'ready' AND document.deleted_at IS NULL
  ON CONFLICT DO NOTHING;
  UPDATE public.knowledge_index_generations SET status = 'retired',
    retired_at = clock_timestamp(),
    retain_until = clock_timestamp() + interval '7 days'
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
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := md5(concat_ws(
    ':', p_knowledge_base_id, p_storage_references::text
  ));
  references_to_delete jsonb;
  response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'orphan_cleanup' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  WITH reserved AS (
    UPDATE public.knowledge_objects AS object
      SET state = 'cleanup_reserved', cleanup_request_id = p_request_id,
        cleanup_reserved_at = clock_timestamp()
      WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
        AND object.state IN ('authorized', 'orphaned')
        AND object.storage_reference IN (SELECT jsonb_array_elements_text(p_storage_references))
        AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
          WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
            AND version.source_object_id = object.id)
      RETURNING object.storage_reference
  ) SELECT COALESCE(jsonb_agg(storage_reference ORDER BY storage_reference), '[]'::jsonb)
      INTO references_to_delete FROM reserved;
  response := jsonb_build_object('storageReferences', references_to_delete);
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'orphan_cleanup', fingerprint, response);
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
  removed integer;
BEGIN
  UPDATE public.knowledge_objects AS object
    SET state = 'deleted', deleted_at = clock_timestamp()
    WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
      AND object.state = 'cleanup_reserved'
      AND object.cleanup_request_id = p_request_id
      AND object.storage_reference IN (SELECT jsonb_array_elements_text(p_storage_references))
      AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
        WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
          AND version.source_object_id = object.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN jsonb_build_object('removed', removed);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_get_job(
  p_caller_user_id varchar, p_job_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  job public.knowledge_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.knowledge_jobs WHERE id = p_job_id AND owner_id = owner;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object(
    'jobId', job.id, 'state', job.state, 'errorCode', job.error_code
  );
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

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_get_embedding_consent(
  p_caller_user_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  retrieval_by_base jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  INSERT INTO public.knowledge_embedding_consents(owner_id)
    VALUES (owner) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'knowledgeBaseId', base.id,
    'retrievalMode', CASE
      WHEN consent.status <> 'granted' THEN 'keyword_only'
      WHEN EXISTS (
        SELECT 1 FROM public.knowledge_chunk_embeddings embedding
        WHERE embedding.owner_id = owner
          AND embedding.knowledge_base_id = base.id
          AND embedding.generation_id = base.published_generation_id
      ) THEN 'hybrid'
      WHEN EXISTS (
        SELECT 1 FROM public.knowledge_jobs job
        WHERE job.owner_id = owner AND job.knowledge_base_id = base.id
          AND job.kind IN ('embedding_index', 'embedding_reindex')
          AND job.state IN ('queued', 'running', 'paused')
      ) THEN 'reindexing'
      ELSE 'keyword_only'
    END
  ) ORDER BY base.id), '[]'::jsonb) INTO retrieval_by_base
  FROM public.knowledge_bases base
  WHERE base.owner_id = owner AND base.deleted_at IS NULL;
  RETURN jsonb_build_object(
    'processor', 'tokenhub', 'processingRegion', 'Guangzhou',
    'model', 'kinfra-text-embedding-0.6b', 'dimensions', 1024,
    'status', consent.status, 'retrievalByBase', retrieval_by_base,
    'updatedAt', to_char(
      consent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_begin_embedding_send(
  p_caller_user_id varchar, p_purpose varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  token varchar;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('query', 'index', 'drift') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  INSERT INTO public.knowledge_embedding_consents(owner_id)
    VALUES (owner) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  IF consent.status <> 'granted' THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_CONSENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_embedding_send_leases SET
    state = 'expired', updated_at = clock_timestamp()
    WHERE owner_id = owner AND state IN ('admitted', 'sending')
      AND expires_at <= clock_timestamp();
  token := 'lease_' || md5(
    owner::text || ':' || clock_timestamp()::text || ':' || random()::text
  ) || md5(clock_timestamp()::text || ':' || random()::text);
  INSERT INTO public.knowledge_embedding_send_leases(
    lease_token, owner_id, consent_epoch, purpose, state, expires_at, updated_at
  ) VALUES (
    token, owner, consent.authorization_epoch, p_purpose, 'admitted',
    clock_timestamp() + interval '10 seconds', clock_timestamp()
  );
  RETURN jsonb_build_object(
    'leaseToken', token, 'consentEpoch', consent.authorization_epoch
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_start_embedding_send(
  p_caller_user_id varchar, p_lease_token varchar, p_consent_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  lease public.knowledge_embedding_send_leases%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_lease_token IS NULL OR length(p_lease_token) = 0
    OR p_consent_epoch IS NULL OR p_consent_epoch < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  SELECT * INTO lease FROM public.knowledge_embedding_send_leases
    WHERE owner_id = owner AND lease_token = p_lease_token
      AND consent_epoch = p_consent_epoch FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('started', false, 'state', 'expired');
  END IF;
  IF lease.state <> 'admitted' THEN
    RETURN jsonb_build_object('started', false, 'state', lease.state);
  END IF;
  IF consent.status <> 'granted'
    OR consent.authorization_epoch <> p_consent_epoch
    OR lease.consent_epoch <> p_consent_epoch
    OR lease.expires_at <= clock_timestamp() THEN
    UPDATE public.knowledge_embedding_send_leases SET state = 'expired',
      expires_at = least(expires_at, clock_timestamp()),
      updated_at = clock_timestamp()
      WHERE owner_id = owner AND lease_token = p_lease_token
        AND consent_epoch = p_consent_epoch AND state = 'admitted';
    RETURN jsonb_build_object('started', false, 'state', 'expired');
  END IF;
  deadline := clock_timestamp() + interval '30 seconds';
  UPDATE public.knowledge_embedding_send_leases SET state = 'sending',
    expires_at = deadline, updated_at = clock_timestamp()
    WHERE owner_id = owner AND lease_token = p_lease_token
      AND consent_epoch = p_consent_epoch AND state = 'admitted';
  RETURN jsonb_build_object(
    'started', true, 'state', 'sending',
    'sendDeadlineMs', floor(extract(epoch FROM deadline) * 1000)::bigint
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_embedding_send(
  p_caller_user_id varchar, p_lease_token varchar, p_consent_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  lease public.knowledge_embedding_send_leases%ROWTYPE;
  lease_state varchar;
BEGIN
  IF p_lease_token IS NULL OR length(p_lease_token) = 0
    OR p_consent_epoch IS NULL OR p_consent_epoch < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'state', 'missing');
  END IF;
  SELECT * INTO lease FROM public.knowledge_embedding_send_leases
    WHERE owner_id = owner AND lease_token = p_lease_token
      AND consent_epoch = p_consent_epoch FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'state', 'missing');
  END IF;
  IF lease.state = 'released' THEN
    RETURN jsonb_build_object('released', true, 'state', 'released');
  END IF;
  IF lease.state = 'expired' THEN
    RETURN jsonb_build_object('released', false, 'state', 'expired');
  END IF;
  IF lease.state = 'admitted' THEN
    IF consent.status <> 'granted'
      OR consent.authorization_epoch <> p_consent_epoch
      OR lease.expires_at <= clock_timestamp() THEN
      UPDATE public.knowledge_embedding_send_leases SET state = 'expired',
        expires_at = least(expires_at, clock_timestamp()),
        updated_at = clock_timestamp()
        WHERE owner_id = owner AND lease_token = p_lease_token
          AND consent_epoch = p_consent_epoch AND state = 'admitted';
      RETURN jsonb_build_object('released', false, 'state', 'expired');
    END IF;
    RETURN jsonb_build_object('released', false, 'state', 'admitted');
  END IF;
  IF lease.state <> 'sending' THEN
    RETURN jsonb_build_object('released', false, 'state', lease.state);
  END IF;
  IF consent.status <> 'granted'
    OR consent.authorization_epoch <> p_consent_epoch THEN
    UPDATE public.knowledge_embedding_send_leases SET state = 'expired',
      expires_at = least(expires_at, clock_timestamp()),
      updated_at = clock_timestamp()
      WHERE owner_id = owner AND lease_token = p_lease_token
        AND consent_epoch = p_consent_epoch AND state = 'sending';
    RETURN jsonb_build_object('released', false, 'state', 'expired');
  END IF;
  UPDATE public.knowledge_embedding_send_leases SET
    state = 'released', updated_at = clock_timestamp()
    WHERE owner_id = owner AND lease_token = p_lease_token
      AND consent_epoch = p_consent_epoch
      AND state = 'sending' AND expires_at > clock_timestamp()
    RETURNING state INTO lease_state;
  IF NOT FOUND THEN
    UPDATE public.knowledge_embedding_send_leases SET state = 'expired',
      expires_at = least(expires_at, clock_timestamp()),
      updated_at = clock_timestamp()
      WHERE owner_id = owner AND lease_token = p_lease_token
        AND consent_epoch = p_consent_epoch AND state = 'sending';
    RETURN jsonb_build_object('released', false, 'state', 'expired');
  END IF;
  RETURN jsonb_build_object('released', true, 'state', 'released');
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_set_embedding_consent(
  p_caller_user_id varchar, p_request_id varchar, p_status varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  previous_status varchar := 'unknown';
  consent public.knowledge_embedding_consents%ROWTYPE;
  request_row public.knowledge_requests%ROWTYPE;
  fingerprint char(32) := md5(p_status);
  response jsonb;
  retrieval_by_base jsonb;
BEGIN
  IF p_status IS NULL OR NOT (p_status IN ('granted', 'denied', 'revoked')) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_status = 'granted' THEN
    PERFORM public.autoforge_knowledge_require_cloud(owner);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'embedding_consent' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  INSERT INTO public.knowledge_embedding_consents(owner_id)
    VALUES (owner) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  previous_status := consent.status;
  UPDATE public.knowledge_embedding_consents SET
    status = p_status,
    authorization_epoch = authorization_epoch + 1,
    updated_at = clock_timestamp()
    WHERE owner_id = owner
    RETURNING * INTO STRICT consent;
  IF p_status IN ('denied', 'revoked') THEN
    UPDATE public.knowledge_embedding_send_leases SET state = 'expired',
      expires_at = least(expires_at, clock_timestamp()),
      updated_at = clock_timestamp()
      WHERE owner_id = owner AND consent_epoch < consent.authorization_epoch
        AND state = 'admitted';
    UPDATE public.knowledge_embedding_send_leases SET
      state = 'expired', updated_at = clock_timestamp()
      WHERE owner_id = owner AND consent_epoch < consent.authorization_epoch
        AND state = 'sending' AND expires_at <= clock_timestamp();
    WHILE EXISTS (
      SELECT 1 FROM public.knowledge_embedding_send_leases send
      WHERE send.owner_id = owner
        AND send.consent_epoch < consent.authorization_epoch
        AND send.state = 'sending'
        AND send.expires_at > clock_timestamp()
    ) LOOP
      PERFORM pg_sleep(0.01);
      UPDATE public.knowledge_embedding_send_leases SET
        state = 'expired', updated_at = clock_timestamp()
        WHERE owner_id = owner AND consent_epoch < consent.authorization_epoch
          AND state = 'sending' AND expires_at <= clock_timestamp();
    END LOOP;
    UPDATE public.knowledge_embedding_send_leases SET
      state = 'expired', updated_at = clock_timestamp()
      WHERE owner_id = owner AND consent_epoch < consent.authorization_epoch
        AND state = 'sending';
    DELETE FROM public.knowledge_chunk_embeddings WHERE owner_id = owner;
  ELSIF p_status = 'granted' AND previous_status <> 'granted' THEN
    INSERT INTO public.knowledge_jobs(
      id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
    ) SELECT
      'job_' || md5(owner::text || ':' || base.id || ':' || p_request_id),
      owner, base.id,
      'consent_' || md5(owner::text || ':' || base.id || ':' || p_request_id),
      'embedding_reindex', base.id, 'queued'
    FROM public.knowledge_bases base
    WHERE base.owner_id = owner AND base.deleted_at IS NULL
    ON CONFLICT(owner_id, request_id) DO NOTHING;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'knowledgeBaseId', base.id,
    'retrievalMode', CASE
      WHEN p_status <> 'granted' THEN 'keyword_only'
      WHEN EXISTS (
        SELECT 1 FROM public.knowledge_chunk_embeddings embedding
        WHERE embedding.owner_id = owner
          AND embedding.knowledge_base_id = base.id
          AND embedding.generation_id = base.published_generation_id
      ) THEN 'hybrid'
      WHEN EXISTS (
        SELECT 1 FROM public.knowledge_jobs job
        WHERE job.owner_id = owner AND job.knowledge_base_id = base.id
          AND job.kind IN ('embedding_index', 'embedding_reindex')
          AND job.state IN ('queued', 'running', 'paused')
      ) THEN 'reindexing'
      ELSE 'keyword_only'
    END
  ) ORDER BY base.id), '[]'::jsonb) INTO retrieval_by_base
  FROM public.knowledge_bases base
  WHERE base.owner_id = owner AND base.deleted_at IS NULL;
  response := jsonb_build_object(
    'processor', 'tokenhub', 'processingRegion', 'Guangzhou',
    'model', 'kinfra-text-embedding-0.6b', 'dimensions', 1024,
    'status', p_status,
    'retrievalByBase', retrieval_by_base,
    'updatedAt', to_char(
      clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  INSERT INTO public.knowledge_requests(owner_id, request_id, action, input_hash, response)
    VALUES (owner, p_request_id, 'embedding_consent', fingerprint, response);
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_capture_published_snapshot(
  p_caller_user_id varchar, p_knowledge_base_ids jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  result jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF jsonb_typeof(p_knowledge_base_ids) <> 'array'
    OR jsonb_array_length(p_knowledge_base_ids) NOT BETWEEN 1 AND 32
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_knowledge_base_ids) AS values_(value)
      WHERE jsonb_typeof(value) <> 'string' OR length(value #>> '{}') NOT BETWEEN 1 AND 128
    )
    OR (SELECT count(*) FROM jsonb_array_elements_text(p_knowledge_base_ids)) <>
      (SELECT count(DISTINCT value)
        FROM jsonb_array_elements_text(p_knowledge_base_ids) AS values_(value)) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  WITH requested AS (
    SELECT value AS knowledge_base_id, ordinal
    FROM jsonb_array_elements_text(p_knowledge_base_ids) WITH ORDINALITY input(value, ordinal)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'knowledgeBaseId', base.id, 'generationId', generation.id
  ) ORDER BY requested.ordinal), '[]'::jsonb) INTO result
  FROM requested
  JOIN public.knowledge_bases base
    ON base.owner_id = owner AND base.id = requested.knowledge_base_id
      AND base.published_generation_id IS NOT NULL AND base.deleted_at IS NULL
  JOIN public.knowledge_index_generations generation
    ON generation.owner_id = owner AND generation.knowledge_base_id = base.id
      AND generation.id = base.published_generation_id AND generation.status = 'published';
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_prepare_embedding_generation(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_generation_id varchar, p_expected_published_generation_id varchar,
  p_model varchar, p_configuration jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  base public.knowledge_bases%ROWTYPE;
  consent_status varchar;
  generation public.knowledge_index_generations%ROWTYPE;
  chunks jsonb;
  job_id varchar := 'job_' || md5(owner::text || ':' || p_generation_id || ':embedding');
  job_request_id varchar := 'embed_' || md5(owner::text || ':' || p_request_id);
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT status INTO consent_status FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR SHARE;
  IF consent_status IS DISTINCT FROM 'granted' THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_CONSENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_model <> 'kinfra-text-embedding-0.6b'
    OR p_configuration <> jsonb_build_object(
      'version', 1, 'dimensions', 1024, 'fusion', 'rrf', 'rrfConstant', 60,
      'vectorSearch', 'exact_cosine', 'exactCosineMaxChunks', 10000
    ) THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_MODEL_INVALID', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO base FROM public.knowledge_bases
    WHERE owner_id = owner AND id = p_knowledge_base_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  IF base.published_generation_id IS DISTINCT FROM p_expected_published_generation_id THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id FOR UPDATE;
  IF FOUND AND generation.status <> 'staging' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  ELSIF FOUND THEN
    UPDATE public.knowledge_index_generations
      SET model = p_model, configuration = p_configuration
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
        AND id = p_generation_id;
  ELSE
    INSERT INTO public.knowledge_index_generations(
      id, owner_id, knowledge_base_id, status, model, configuration
    ) VALUES (
      p_generation_id, owner, p_knowledge_base_id, 'staging',
      'kinfra-text-embedding-0.6b', p_configuration
    );
  END IF;
  INSERT INTO public.knowledge_jobs(
    id, owner_id, knowledge_base_id, request_id, kind, entity_id, state
  ) VALUES (
    job_id, owner, p_knowledge_base_id, job_request_id,
    'embedding_index', p_generation_id, 'running'
  ) ON CONFLICT(owner_id, request_id) DO UPDATE SET
    state = CASE WHEN public.knowledge_jobs.state IN ('completed', 'cancelled')
      THEN public.knowledge_jobs.state ELSE 'running' END,
    updated_at = clock_timestamp();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'chunkId', chunk.id, 'body', chunk.body
  ) ORDER BY document.id, chunk.ordinal, chunk.id), '[]'::jsonb) INTO chunks
  FROM public.knowledge_documents document
  JOIN public.knowledge_versions version
    ON version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
      AND version.document_id = document.id AND version.id = document.active_version_id
      AND version.status = 'ready'
  JOIN public.knowledge_chunks chunk
    ON chunk.owner_id = owner AND chunk.knowledge_base_id = p_knowledge_base_id
      AND chunk.document_id = document.id AND chunk.version_id = version.id
  WHERE document.owner_id = owner AND document.knowledge_base_id = p_knowledge_base_id
    AND document.status = 'ready' AND document.deleted_at IS NULL;
  RETURN jsonb_build_object(
    'consentStatus', consent_status, 'generationId', p_generation_id, 'chunks', chunks
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_embedding_generation(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_generation_id varchar, p_model varchar, p_configuration jsonb,
  p_probe_fingerprint varchar, p_embeddings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  generation public.knowledge_index_generations%ROWTYPE;
  consent_status varchar;
  expected_count integer;
  supplied_count integer;
  distinct_count integer;
  item jsonb;
  vector double precision[];
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  SELECT status INTO consent_status FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR SHARE;
  IF consent_status IS DISTINCT FROM 'granted' THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_CONSENT_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_model <> 'kinfra-text-embedding-0.6b'
    OR p_configuration <> jsonb_build_object(
      'version', 1, 'dimensions', 1024, 'fusion', 'rrf', 'rrfConstant', 60,
      'vectorSearch', 'exact_cosine', 'exactCosineMaxChunks', 10000
    )
    OR p_probe_fingerprint !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p_embeddings) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_MODEL_INVALID', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id FOR UPDATE;
  IF NOT FOUND OR generation.status <> 'staging'
    OR generation.model <> p_model OR generation.configuration <> p_configuration THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO expected_count
  FROM public.knowledge_documents document
  JOIN public.knowledge_chunks chunk
    ON chunk.owner_id = owner AND chunk.knowledge_base_id = p_knowledge_base_id
      AND chunk.document_id = document.id AND chunk.version_id = document.active_version_id
  JOIN public.knowledge_versions version
    ON version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
      AND version.document_id = document.id AND version.id = document.active_version_id
      AND version.status = 'ready'
  WHERE document.owner_id = owner AND document.knowledge_base_id = p_knowledge_base_id
    AND document.status = 'ready' AND document.deleted_at IS NULL;
  SELECT count(*), count(DISTINCT (value->>'chunkId'))
    INTO supplied_count, distinct_count
    FROM jsonb_array_elements(p_embeddings) AS values_(value);
  IF supplied_count <> expected_count OR distinct_count <> supplied_count THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_MODEL_INVALID', ERRCODE = 'P0001';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_embeddings) AS values_(value) LOOP
    IF jsonb_typeof(item->'embedding') <> 'array'
      OR jsonb_array_length(item->'embedding') <> 1024
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(item->'embedding') AS components(component)
        WHERE jsonb_typeof(component) <> 'number'
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.knowledge_chunks chunk
        JOIN public.knowledge_documents document
          ON document.owner_id = owner AND document.knowledge_base_id = p_knowledge_base_id
            AND document.id = chunk.document_id AND document.active_version_id = chunk.version_id
            AND document.status = 'ready' AND document.deleted_at IS NULL
        WHERE chunk.owner_id = owner AND chunk.knowledge_base_id = p_knowledge_base_id
          AND chunk.id = item->>'chunkId'
      ) THEN
      RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_MODEL_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT array_agg((component #>> '{}')::double precision ORDER BY ordinal)
      INTO vector
    FROM jsonb_array_elements(item->'embedding') WITH ORDINALITY values_(component, ordinal);
    INSERT INTO public.knowledge_generation_chunks(
      owner_id, knowledge_base_id, generation_id, chunk_id
    ) VALUES (owner, p_knowledge_base_id, p_generation_id, item->>'chunkId')
    ON CONFLICT DO NOTHING;
    INSERT INTO public.knowledge_chunk_embeddings(
      owner_id, knowledge_base_id, generation_id, chunk_id, model, dimensions, embedding
    ) VALUES (
      owner, p_knowledge_base_id, p_generation_id, item->>'chunkId',
      'kinfra-text-embedding-0.6b', 1024, vector
    ) ON CONFLICT(owner_id, knowledge_base_id, generation_id, chunk_id) DO UPDATE SET
      model = excluded.model, dimensions = excluded.dimensions,
      embedding = excluded.embedding, created_at = clock_timestamp();
  END LOOP;
  UPDATE public.knowledge_index_generations SET
    status = 'ready', probe_fingerprint = p_probe_fingerprint,
    ready_at = clock_timestamp()
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id AND status = 'staging';
  UPDATE public.knowledge_jobs SET state = 'completed', updated_at = clock_timestamp(),
    lease_token = NULL, lease_expires_at = NULL, error_code = NULL
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND kind = 'embedding_index' AND entity_id = p_generation_id
      AND state IN ('queued', 'running', 'paused');
  RETURN jsonb_build_object('generationId', p_generation_id, 'status', 'ready');
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_fail_embedding_generation(
  p_caller_user_id varchar, p_knowledge_base_id varchar,
  p_generation_id varchar, p_error_code varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
BEGIN
  UPDATE public.knowledge_index_generations SET status = 'failed'
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id AND status = 'staging';
  UPDATE public.knowledge_jobs SET state = 'failed', error_code = left(p_error_code, 64),
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND kind = 'embedding_index' AND entity_id = p_generation_id
      AND state IN ('queued', 'running', 'paused');
  RETURN jsonb_build_object('failed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_prepare_drift_generation(
  p_caller_user_id varchar, p_request_id varchar, p_knowledge_base_id varchar,
  p_generation_id varchar, p_expected_published_generation_id varchar,
  p_model varchar, p_configuration jsonb, p_probe_fingerprint varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  current_published_generation_id varchar;
  published_model varchar;
  published_configuration jsonb;
  published_probe char(64);
  prepared jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_model <> 'kinfra-text-embedding-0.6b'
    OR p_configuration <> jsonb_build_object(
      'version', 1, 'dimensions', 1024, 'fusion', 'rrf', 'rrfConstant', 60,
      'vectorSearch', 'exact_cosine', 'exactCosineMaxChunks', 10000
    )
    OR p_probe_fingerprint IS NULL OR p_probe_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'EMBEDDING_MODEL_INVALID', ERRCODE = 'P0001';
  END IF;
  SELECT base.published_generation_id, generation.model,
    generation.configuration, generation.probe_fingerprint
    INTO current_published_generation_id, published_model,
      published_configuration, published_probe
  FROM public.knowledge_bases base
  LEFT JOIN public.knowledge_index_generations generation
    ON generation.owner_id = base.owner_id
      AND generation.knowledge_base_id = base.id
      AND generation.id = base.published_generation_id
      AND generation.status = 'published'
  WHERE base.owner_id = owner AND base.id = p_knowledge_base_id
    AND base.deleted_at IS NULL
  FOR UPDATE OF base;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001'; END IF;
  IF current_published_generation_id IS DISTINCT FROM p_expected_published_generation_id THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  IF published_probe = p_probe_fingerprint
    AND published_model = p_model
    AND published_configuration = p_configuration THEN
    RETURN jsonb_build_object(
      'drifted', false, 'publishedGenerationId', p_expected_published_generation_id
    );
  END IF;
  prepared := public.autoforge_knowledge_prepare_embedding_generation(
    p_caller_user_id, p_request_id, p_knowledge_base_id, p_generation_id,
    p_expected_published_generation_id, p_model, p_configuration
  );
  RETURN prepared || jsonb_build_object('drifted', true, 'probeFingerprint', p_probe_fingerprint);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_search_published(
  p_caller_user_id varchar, p_query varchar, p_snapshot jsonb,
  p_keyword_limit integer, p_exact_cosine_max_chunks integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent_status varchar := 'unknown';
  keyword_candidates jsonb;
  vector_rows jsonb := '[]'::jsonb;
  vector_count integer := 0;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_query IS NULL OR length(btrim(p_query)) NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(p_snapshot) <> 'array'
    OR jsonb_array_length(p_snapshot) NOT BETWEEN 1 AND 32
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_snapshot) AS snapshots(value)
      WHERE jsonb_typeof(value) <> 'object'
        OR length(value->>'knowledgeBaseId') NOT BETWEEN 1 AND 128
        OR length(value->>'generationId') NOT BETWEEN 1 AND 128
    )
    OR (SELECT count(*) FROM jsonb_array_elements(p_snapshot)) <>
      (SELECT count(DISTINCT (value->>'knowledgeBaseId'))
        FROM jsonb_array_elements(p_snapshot) AS snapshots(value))
    OR p_keyword_limit NOT BETWEEN 1 AND 32
    OR p_exact_cosine_max_chunks NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT status INTO consent_status FROM public.knowledge_embedding_consents
    WHERE owner_id = owner;
  IF NOT FOUND THEN consent_status := 'unknown'; END IF;
  WITH requested AS (
    SELECT value->>'knowledgeBaseId' AS knowledge_base_id,
      value->>'generationId' AS generation_id, ordinal
    FROM jsonb_array_elements(p_snapshot) WITH ORDINALITY input(value, ordinal)
  ), published AS (
    SELECT requested.knowledge_base_id, requested.generation_id, requested.ordinal
    FROM requested
    JOIN public.knowledge_bases base
      ON base.owner_id = owner AND base.id = requested.knowledge_base_id
        AND base.published_generation_id = requested.generation_id
        AND base.deleted_at IS NULL
    JOIN public.knowledge_index_generations generation
      ON generation.owner_id = owner
        AND generation.knowledge_base_id = requested.knowledge_base_id
        AND generation.id = requested.generation_id
        AND generation.status = 'published'
  ), ranked AS (
    SELECT generation_chunk.chunk_id, generation_chunk.generation_id,
      chunk.knowledge_base_id, chunk.document_id, chunk.version_id,
      chunk.body, chunk.coordinates, chunk.ordinal, published.ordinal AS base_ordinal
    FROM published
    JOIN public.knowledge_generation_chunks generation_chunk
      ON generation_chunk.owner_id = owner
        AND generation_chunk.knowledge_base_id = published.knowledge_base_id
        AND generation_chunk.generation_id = published.generation_id
    JOIN public.knowledge_chunks chunk
      ON chunk.owner_id = owner AND chunk.knowledge_base_id = published.knowledge_base_id
        AND chunk.id = generation_chunk.chunk_id
    JOIN public.knowledge_documents document
      ON document.owner_id = owner AND document.knowledge_base_id = chunk.knowledge_base_id
        AND document.id = chunk.document_id AND document.active_version_id = chunk.version_id
        AND document.status = 'ready' AND document.deleted_at IS NULL
    WHERE position(lower(p_query) in lower(chunk.body)) > 0
    ORDER BY published.ordinal, position(lower(p_query) in lower(chunk.body)),
      chunk.ordinal, chunk.id
    LIMIT p_keyword_limit
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'chunkId', ranked.chunk_id, 'generationId', ranked.generation_id,
    'evidence', jsonb_build_object(
      'evidenceId', 'evidence_' || md5(ranked.generation_id || ':' || ranked.chunk_id),
      'knowledgeBaseId', ranked.knowledge_base_id,
      'documentId', ranked.document_id, 'versionId', ranked.version_id,
      'snippet', left(ranked.body, 4000), 'score', 0,
      'citation', jsonb_build_object(
        'evidenceId', 'evidence_' || md5(ranked.generation_id || ':' || ranked.chunk_id),
        'documentId', ranked.document_id, 'versionId', ranked.version_id
      ) || ranked.coordinates
    )
  ) ORDER BY ranked.base_ordinal, ranked.ordinal, ranked.chunk_id), '[]'::jsonb)
    INTO keyword_candidates FROM ranked;
  WITH requested AS (
    SELECT value->>'knowledgeBaseId' AS knowledge_base_id,
      value->>'generationId' AS generation_id
    FROM jsonb_array_elements(p_snapshot) AS values_(value)
  ), published AS (
    SELECT requested.knowledge_base_id, requested.generation_id
    FROM requested
    JOIN public.knowledge_bases base
      ON base.owner_id = owner AND base.id = requested.knowledge_base_id
        AND base.published_generation_id = requested.generation_id
        AND base.deleted_at IS NULL
    JOIN public.knowledge_index_generations generation
      ON generation.owner_id = owner
        AND generation.knowledge_base_id = requested.knowledge_base_id
        AND generation.id = requested.generation_id
        AND generation.status = 'published'
  )
  SELECT count(*) INTO vector_count
  FROM published
  JOIN public.knowledge_chunk_embeddings embedding
    ON embedding.owner_id = owner
      AND embedding.knowledge_base_id = published.knowledge_base_id
      AND embedding.generation_id = published.generation_id;
  IF vector_count > 0 AND vector_count <= p_exact_cosine_max_chunks THEN
    WITH requested AS (
      SELECT value->>'knowledgeBaseId' AS knowledge_base_id,
        value->>'generationId' AS generation_id
      FROM jsonb_array_elements(p_snapshot) AS values_(value)
    ), rows_ AS (
      SELECT generation_chunk.chunk_id, generation_chunk.generation_id,
        chunk.knowledge_base_id, chunk.document_id, chunk.version_id,
        chunk.body, chunk.coordinates, embedding.embedding
      FROM requested
      JOIN public.knowledge_bases base
        ON base.owner_id = owner AND base.id = requested.knowledge_base_id
          AND base.published_generation_id = requested.generation_id
      JOIN public.knowledge_index_generations generation
        ON generation.owner_id = owner
          AND generation.knowledge_base_id = requested.knowledge_base_id
          AND generation.id = requested.generation_id AND generation.status = 'published'
      JOIN public.knowledge_generation_chunks generation_chunk
        ON generation_chunk.owner_id = owner
          AND generation_chunk.knowledge_base_id = requested.knowledge_base_id
          AND generation_chunk.generation_id = requested.generation_id
      JOIN public.knowledge_chunk_embeddings embedding
        ON embedding.owner_id = generation_chunk.owner_id
          AND embedding.knowledge_base_id = generation_chunk.knowledge_base_id
          AND embedding.generation_id = generation_chunk.generation_id
          AND embedding.chunk_id = generation_chunk.chunk_id
      JOIN public.knowledge_chunks chunk
        ON chunk.owner_id = generation_chunk.owner_id
          AND chunk.knowledge_base_id = generation_chunk.knowledge_base_id
          AND chunk.id = generation_chunk.chunk_id
      JOIN public.knowledge_documents document
        ON document.owner_id = owner AND document.knowledge_base_id = chunk.knowledge_base_id
          AND document.id = chunk.document_id AND document.active_version_id = chunk.version_id
          AND document.status = 'ready' AND document.deleted_at IS NULL
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'candidate', jsonb_build_object(
        'chunkId', rows_.chunk_id, 'generationId', rows_.generation_id,
        'evidence', jsonb_build_object(
          'evidenceId', 'evidence_' || md5(rows_.generation_id || ':' || rows_.chunk_id),
          'knowledgeBaseId', rows_.knowledge_base_id,
          'documentId', rows_.document_id, 'versionId', rows_.version_id,
          'snippet', left(rows_.body, 4000), 'score', 0,
          'citation', jsonb_build_object(
            'evidenceId', 'evidence_' || md5(rows_.generation_id || ':' || rows_.chunk_id),
            'documentId', rows_.document_id, 'versionId', rows_.version_id
          ) || rows_.coordinates
        )
      ), 'embedding', to_jsonb(rows_.embedding)
    ) ORDER BY rows_.generation_id, rows_.chunk_id), '[]'::jsonb)
      INTO vector_rows FROM rows_;
  END IF;
  RETURN jsonb_build_object(
    'embeddingConsentStatus', consent_status,
    'keywordCandidates', keyword_candidates,
    'vectorEligible', vector_count > 0 AND vector_count <= p_exact_cosine_max_chunks,
    'vectorRows', vector_rows
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
  UPDATE public.knowledge_jobs SET state = 'failed', error_code = 'LEASE_EXPIRED',
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE state = 'running' AND attempt >= 3 AND lease_expires_at <= clock_timestamp();
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
DECLARE
  changed integer;
  next_state varchar;
BEGIN
  IF p_state NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  next_state := CASE
    WHEN p_state = 'failed' AND p_error_code = 'TRANSIENT_FAILURE' THEN 'queued'
    ELSE p_state
  END;
  UPDATE public.knowledge_jobs SET state = CASE
      WHEN next_state = 'queued' AND attempt >= 3 THEN 'failed' ELSE next_state END,
    error_code = p_error_code,
    lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE id = p_job_id AND state = 'running' AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('completed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cleanup_retention(
  p_worker_id varchar, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  pruned_changes integer := 0;
  pruned_tombstones integer := 0;
  pruned_generations integer := 0;
  pruned_embedding_send_leases integer := 0;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.knowledge_tombstones WHERE id IN (
    SELECT id FROM public.knowledge_tombstones
    WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT p_limit
  );
  GET DIAGNOSTICS pruned_tombstones = ROW_COUNT;
  WITH candidates AS (
    SELECT change.sequence, change.owner_id, change.knowledge_base_id
    FROM public.knowledge_changes change
    WHERE change.created_at <= clock_timestamp() - interval '90 days'
      AND NOT EXISTS (
        SELECT 1 FROM public.knowledge_tombstones tombstone
        WHERE tombstone.owner_id = change.owner_id
          AND tombstone.knowledge_base_id = change.knowledge_base_id
          AND tombstone.sequence = change.sequence
          AND tombstone.expires_at > clock_timestamp()
      )
    ORDER BY change.sequence LIMIT p_limit
  ), floors AS (
    INSERT INTO public.knowledge_sync_floors(
      owner_id, knowledge_base_id, minimum_sequence, updated_at
    ) SELECT owner_id, knowledge_base_id, max(sequence) + 1, clock_timestamp()
      FROM candidates GROUP BY owner_id, knowledge_base_id
    ON CONFLICT(owner_id, knowledge_base_id) DO UPDATE SET
      minimum_sequence = greatest(
        public.knowledge_sync_floors.minimum_sequence, excluded.minimum_sequence
      ), updated_at = excluded.updated_at
    RETURNING owner_id
  )
  DELETE FROM public.knowledge_changes change
    USING candidates
    WHERE change.owner_id = candidates.owner_id
      AND change.knowledge_base_id = candidates.knowledge_base_id
      AND change.sequence = candidates.sequence;
  GET DIAGNOSTICS pruned_changes = ROW_COUNT;
  DELETE FROM public.knowledge_index_generations generation
    WHERE generation.id IN (
      SELECT retired.id FROM public.knowledge_index_generations retired
      JOIN public.knowledge_bases base
        ON base.owner_id = retired.owner_id AND base.id = retired.knowledge_base_id
      WHERE retired.status = 'retired'
        AND retired.retain_until <= clock_timestamp()
        AND base.published_generation_id IS DISTINCT FROM retired.id
      ORDER BY retired.retain_until LIMIT p_limit
    );
  GET DIAGNOSTICS pruned_generations = ROW_COUNT;
  DELETE FROM public.knowledge_embedding_send_leases WHERE lease_token IN (
    SELECT lease_token FROM public.knowledge_embedding_send_leases
    WHERE state IN ('released', 'expired')
      AND updated_at <= clock_timestamp() - interval '7 days'
    ORDER BY updated_at LIMIT p_limit
  );
  GET DIAGNOSTICS pruned_embedding_send_leases = ROW_COUNT;
  RETURN jsonb_build_object(
    'prunedChanges', pruned_changes, 'prunedTombstones', pruned_tombstones,
    'prunedGenerations', pruned_generations,
    'prunedEmbeddingSendLeases', pruned_embedding_send_leases
  );
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
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_upload(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_verify_upload(varchar, varchar, bigint, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_job(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_embedding_consent(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_embedding_send(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_embedding_send(varchar, varchar, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_set_embedding_consent(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_capture_published_snapshot(varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_embedding_generation(varchar, varchar, varchar, varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, varchar, varchar, jsonb, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_fail_embedding_generation(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_drift_generation(varchar, varchar, varchar, varchar, varchar, varchar, jsonb, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_search_published(varchar, varchar, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_retention(varchar, integer) FROM PUBLIC, anon, authenticated;

DO $grants$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
    'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks',
    'knowledge_index_generations', 'knowledge_embedding_consents',
    'knowledge_embedding_send_leases',
    'knowledge_generation_chunks', 'knowledge_chunk_embeddings',
    'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_sync_floors', 'knowledge_upload_authorizations',
    'knowledge_entitlements', 'knowledge_requests'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$grants$;

GRANT USAGE, SELECT ON SEQUENCE public.knowledge_changes_sequence_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.knowledge_tombstones_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.knowledge_conflicts_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_upload(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_verify_upload(varchar, varchar, bigint, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_job(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_embedding_consent(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_begin_embedding_send(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_start_embedding_send(varchar, varchar, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_embedding_send(varchar, varchar, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_set_embedding_consent(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_capture_published_snapshot(varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_prepare_embedding_generation(varchar, varchar, varchar, varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, varchar, varchar, jsonb, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_fail_embedding_generation(varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_prepare_drift_generation(varchar, varchar, varchar, varchar, varchar, varchar, jsonb, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_search_published(varchar, varchar, jsonb, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cleanup_retention(varchar, integer) TO service_role;

COMMIT;
