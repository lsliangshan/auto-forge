BEGIN;

CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'ready', 'paused', 'deleting', 'deleted')),
  published_generation_id varchar(128),
  revision varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY(owner_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_bases_owner_updated
  ON public.knowledge_bases(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_objects (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  storage_reference varchar(512) NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type varchar(200) NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN ('authorized', 'uploaded', 'verified', 'orphaned', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_objects_owner_base
  ON public.knowledge_objects(owner_id, knowledge_base_id, created_at);

CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id varchar(128) NOT NULL,
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
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_documents_owner_base
  ON public.knowledge_documents(owner_id, knowledge_base_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_versions (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  document_id varchar(128) NOT NULL,
  source_object_id varchar(128),
  version_number integer NOT NULL CHECK (version_number > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  PRIMARY KEY(owner_id, knowledge_base_id, id),
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
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  parser_version varchar(128) NOT NULL,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_blocks (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind varchar(64) NOT NULL,
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  UNIQUE(owner_id, knowledge_base_id, version_id, ordinal),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  document_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  block_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  body text NOT NULL,
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  UNIQUE(owner_id, knowledge_base_id, version_id, ordinal),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, document_id)
    REFERENCES public.knowledge_documents(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, block_id)
    REFERENCES public.knowledge_blocks(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_owner_base_version
  ON public.knowledge_chunks(owner_id, knowledge_base_id, version_id);

CREATE TABLE IF NOT EXISTS public.knowledge_index_generations (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('staging', 'ready', 'published', 'retained', 'failed', 'retired')),
  model varchar(128) NOT NULL DEFAULT 'kinfra-text-embedding-0.6b'
    CHECK (model = 'kinfra-text-embedding-0.6b'),
  embedding_dimensions smallint NOT NULL DEFAULT 1024 CHECK (embedding_dimensions = 1024),
  configuration_version varchar(128) NOT NULL DEFAULT 'autoforge-knowledge-embedding-v1'
    CHECK (configuration_version = 'autoforge-knowledge-embedding-v1'),
  configuration jsonb NOT NULL DEFAULT '{"distance":"cosine","normalization":"none","region":"guangzhou"}'::jsonb
    CHECK (configuration = '{"distance":"cosine","normalization":"none","region":"guangzhou"}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  published_at timestamptz,
  retained_until timestamptz,
  PRIMARY KEY(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_one_published_generation
  ON public.knowledge_index_generations(owner_id, knowledge_base_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS public.knowledge_generation_memberships (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  generation_id varchar(128) NOT NULL,
  chunk_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, generation_id, chunk_id),
  UNIQUE(owner_id, knowledge_base_id, generation_id, chunk_id, version_id),
  UNIQUE(owner_id, knowledge_base_id, generation_id, ordinal),
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id)
    REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, chunk_id)
    REFERENCES public.knowledge_chunks(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, version_id)
    REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_generation_membership_version
  ON public.knowledge_generation_memberships(
    owner_id, knowledge_base_id, generation_id, version_id, ordinal
  );

CREATE TABLE IF NOT EXISTS public.knowledge_embedding_consents (
  owner_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL DEFAULT 'revoked'
    CHECK (state IN ('granted', 'revoking', 'revoked')),
  consent_epoch bigint NOT NULL DEFAULT 0 CHECK (consent_epoch >= 0),
  rebuild_required boolean NOT NULL DEFAULT false,
  granted_at timestamptz,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.knowledge_embedding_dispatch_permits (
  permit_id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('query', 'chunk')),
  request_id varchar(128) NOT NULL,
  attempt_id smallint NOT NULL CHECK (attempt_id BETWEEN 1 AND 3),
  consent_epoch bigint NOT NULL CHECK (consent_epoch >= 0),
  knowledge_base_id varchar(128),
  generation_id varchar(128),
  chunk_id varchar(128),
  model varchar(128) NOT NULL CHECK (model = 'kinfra-text-embedding-0.6b'),
  dimensions smallint NOT NULL CHECK (dimensions = 1024),
  configuration_version varchar(128) NOT NULL
    CHECK (configuration_version = 'autoforge-knowledge-embedding-v1'),
  state varchar(16) NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'dispatching', 'started', 'completed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  dispatching_at timestamptz,
  started_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, permit_id),
  UNIQUE(owner_id, purpose, request_id, attempt_id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id)
    REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, chunk_id)
    REFERENCES public.knowledge_chunks(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  CHECK ((purpose = 'query' AND knowledge_base_id IS NULL
      AND generation_id IS NULL AND chunk_id IS NULL)
    OR (purpose = 'chunk' AND knowledge_base_id IS NOT NULL
      AND generation_id IS NOT NULL AND chunk_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS knowledge_embedding_dispatch_permit_expiry
  ON public.knowledge_embedding_dispatch_permits(state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_one_active_embedding_dispatch_attempt
  ON public.knowledge_embedding_dispatch_permits(owner_id, purpose, request_id)
  WHERE state IN ('issued', 'dispatching', 'started');

CREATE TABLE IF NOT EXISTS public.knowledge_chunk_embeddings (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  generation_id varchar(128) NOT NULL,
  chunk_id varchar(128) NOT NULL,
  version_id varchar(128) NOT NULL,
  model varchar(128) NOT NULL CHECK (model = 'kinfra-text-embedding-0.6b'),
  dimensions smallint NOT NULL CHECK (dimensions = 1024),
  configuration_version varchar(128) NOT NULL
    CHECK (configuration_version = 'autoforge-knowledge-embedding-v1'),
  embedding real[] NOT NULL CHECK (cardinality(embedding) = 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, knowledge_base_id, generation_id, chunk_id),
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id)
    REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id, knowledge_base_id, generation_id, chunk_id, version_id)
    REFERENCES public.knowledge_generation_memberships(
      owner_id, knowledge_base_id, generation_id, chunk_id, version_id
    ) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_embeddings_small_set
  ON public.knowledge_chunk_embeddings(owner_id, knowledge_base_id, generation_id, chunk_id);

ALTER TABLE public.knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_active_version_owner_fk,
  ADD CONSTRAINT knowledge_documents_active_version_owner_fk
  FOREIGN KEY(owner_id, knowledge_base_id, active_version_id)
  REFERENCES public.knowledge_versions(owner_id, knowledge_base_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.knowledge_bases
  DROP CONSTRAINT IF EXISTS knowledge_bases_published_generation_owner_fk,
  ADD CONSTRAINT knowledge_bases_published_generation_owner_fk
  FOREIGN KEY(owner_id, id, published_generation_id)
  REFERENCES public.knowledge_index_generations(owner_id, knowledge_base_id, id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS public.knowledge_jobs (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  kind varchar(64) NOT NULL,
  entity_id varchar(128) NOT NULL,
  state varchar(32) NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  worker_id varchar(128),
  lease_token varchar(128),
  lease_expires_at timestamptz,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, id),
  UNIQUE(owner_id, request_id),
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_jobs_claim
  ON public.knowledge_jobs(state, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_jobs_active_lease
  ON public.knowledge_jobs(lease_token) WHERE lease_token IS NOT NULL;

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
  expected_mime_type varchar(200) NOT NULL,
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
  knowledge_base_id varchar(128),
  action varchar(64) NOT NULL,
  input_hash char(32) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, request_id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_snapshots (
  id varchar(128) NOT NULL,
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  knowledge_base_id varchar(128) NOT NULL,
  snapshot_sequence bigint NOT NULL CHECK (snapshot_sequence >= 0),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, id),
  UNIQUE(owner_id, knowledge_base_id, id),
  FOREIGN KEY(owner_id, knowledge_base_id)
    REFERENCES public.knowledge_bases(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.knowledge_snapshot_items (
  owner_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_id varchar(128) NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  entity_kind varchar(32) NOT NULL CHECK (entity_kind IN ('knowledge_base', 'document', 'metadata')),
  entity_id varchar(128) NOT NULL,
  operation varchar(16) NOT NULL CHECK (operation IN ('upsert', 'delete')),
  revision varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  response_bytes integer NOT NULL CHECK (response_bytes > 0 AND response_bytes <= 131072),
  PRIMARY KEY(owner_id, snapshot_id, ordinal),
  UNIQUE(owner_id, snapshot_id, entity_kind, entity_id),
  FOREIGN KEY(owner_id, snapshot_id)
    REFERENCES public.knowledge_snapshots(owner_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_request_hash(p_value jsonb)
RETURNS char(32)
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$ SELECT md5(p_value::text) $$;

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
    OR NEW.embedding_dimensions IS DISTINCT FROM OLD.embedding_dimensions
    OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version
    OR NEW.configuration IS DISTINCT FROM OLD.configuration
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT ((OLD.status = 'staging' AND NEW.status IN ('ready', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'published')
      OR (OLD.status = 'published' AND NEW.status = 'retained')
      OR (OLD.status = 'retained' AND NEW.status = 'retired')) THEN
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
DROP TRIGGER IF EXISTS knowledge_generation_memberships_immutable
  ON public.knowledge_generation_memberships;
CREATE OR REPLACE FUNCTION public.autoforge_knowledge_generation_membership_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER knowledge_generation_memberships_immutable
BEFORE UPDATE OR DELETE ON public.knowledge_generation_memberships
FOR EACH ROW EXECUTE FUNCTION public.autoforge_knowledge_generation_membership_lifecycle();

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
    'knowledge_sync_floors', 'knowledge_upload_authorizations',
    'knowledge_entitlements', 'knowledge_requests', 'knowledge_snapshots',
    'knowledge_snapshot_items', 'knowledge_embedding_consents',
    'knowledge_chunk_embeddings', 'knowledge_generation_memberships',
    'knowledge_embedding_dispatch_permits'
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
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'begin_sync', 'knowledgeBaseId', p_knowledge_base_id,
    'name', p_name, 'revision', p_revision, 'generationId', p_generation_id
  ));
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
  IF EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE owner_id = owner AND id = p_knowledge_base_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.knowledge_bases(
    id, owner_id, name, status, revision
  ) VALUES (p_knowledge_base_id, owner, p_name, 'staging', p_revision);
  INSERT INTO public.knowledge_index_generations(
    id, owner_id, knowledge_base_id, status, configuration
  ) VALUES (
    p_generation_id, owner, p_knowledge_base_id, 'staging',
    '{"distance":"cosine","normalization":"none","region":"guangzhou"}'::jsonb
  );
  response := jsonb_build_object(
    'knowledgeBaseId', p_knowledge_base_id,
    'generationId', p_generation_id,
    'status', 'staging'
  );
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, p_knowledge_base_id, 'begin_sync', fingerprint, response);
  RETURN response;
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
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'push_mutation', 'knowledgeBaseId', p_knowledge_base_id,
    'entityKind', p_entity_kind, 'entityId', p_entity_id, 'operation', p_operation,
    'baseRevision', p_base_revision, 'payload', p_payload
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
    SELECT COALESCE(max(sequence), 0) INTO next_sequence FROM public.knowledge_changes
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id;
    response := jsonb_build_object(
      'mutationId', p_mutation_id, 'status', 'conflict', 'conflictKind', conflict_kind,
      'localRevision', p_mutation_id, 'remoteRevision', head.revision,
      'sequence', next_sequence
    );
    INSERT INTO public.knowledge_conflicts(
      owner_id, knowledge_base_id, mutation_id, entity_kind, entity_id, conflict_kind,
      local_revision, remote_revision, local_payload, remote_payload, input_hash, response
    ) VALUES (
      owner, p_knowledge_base_id, p_mutation_id, p_entity_kind, p_entity_id, conflict_kind,
      p_mutation_id, head.revision, p_payload, head.payload, fingerprint, response
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
  p_after_sequence bigint, p_limit integer, p_max_bytes integer
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
  IF p_after_sequence IS NULL OR p_after_sequence < 0
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 512
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 65536 AND 786432 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
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
  WITH candidates AS (
    SELECT change.*,
      pg_column_size(jsonb_build_object(
        'sequence', change.sequence, 'entityKind', change.entity_kind,
        'entityId', change.entity_id, 'operation', change.operation,
        'revision', change.revision, 'payload', change.payload
      )) + 64 AS response_bytes
    FROM public.knowledge_changes change
    WHERE change.owner_id = owner AND change.knowledge_base_id = p_knowledge_base_id
      AND change.sequence > p_after_sequence
    ORDER BY change.sequence LIMIT p_limit
  ), measured AS (
    SELECT candidate.*,
      sum(candidate.response_bytes) OVER (ORDER BY candidate.sequence) AS cumulative_bytes
    FROM candidates candidate
  ), selected AS (
    SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes - 4096
  ), page AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'sequence', sequence, 'entityKind', entity_kind, 'entityId', entity_id,
        'operation', operation, 'revision', revision, 'payload', payload
      ) ORDER BY sequence), '[]'::jsonb) AS changes,
      COALESCE(max(sequence), p_after_sequence) AS page_last_sequence
    FROM selected
  )
  SELECT page.changes, page.page_last_sequence, EXISTS(
      SELECT 1 FROM public.knowledge_changes change
      WHERE change.owner_id = owner
        AND change.knowledge_base_id = p_knowledge_base_id
        AND change.sequence > page.page_last_sequence
    ) INTO changes, page_last_sequence, has_more
    FROM page;
  RETURN jsonb_build_object(
    'kind', 'incremental', 'nextSequence', page_last_sequence,
    'hasMore', has_more, 'changes', changes
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_full_resync(
  p_caller_user_id varchar, p_knowledge_base_id varchar, p_snapshot_id varchar,
  p_after_ordinal integer, p_limit integer, p_max_bytes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  snapshot public.knowledge_snapshots%ROWTYPE;
  created_snapshot_id varchar;
  next_ordinal integer;
  has_more boolean;
  changes jsonb;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_after_ordinal IS NULL OR p_after_ordinal < 0
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 512
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 65536 AND 786432
    OR (p_snapshot_id IS NULL AND p_after_ordinal <> 0) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases
    WHERE id = p_knowledge_base_id AND owner_id = owner) THEN
    RAISE EXCEPTION USING MESSAGE = 'NOT_FOUND', ERRCODE = 'P0001';
  END IF;
  IF p_snapshot_id IS NULL THEN
    created_snapshot_id := 'snapshot_' || md5(
      owner::text || ':' || p_knowledge_base_id || ':' || clock_timestamp()::text || ':' || random()::text
    );
    WITH snapshot_boundary AS MATERIALIZED (
      SELECT greatest(
        COALESCE((SELECT max(sequence) FROM public.knowledge_changes
          WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0),
        COALESCE((SELECT minimum_sequence - 1 FROM public.knowledge_sync_floors
          WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id), 0)
      ) AS latest
    ), created_snapshot AS (
      INSERT INTO public.knowledge_snapshots(
        id, owner_id, knowledge_base_id, snapshot_sequence
      ) SELECT created_snapshot_id, owner, p_knowledge_base_id, boundary.latest
        FROM snapshot_boundary boundary
      RETURNING id, owner_id, snapshot_sequence
    )
    INSERT INTO public.knowledge_snapshot_items(
      owner_id, snapshot_id, ordinal, entity_kind, entity_id,
      operation, revision, payload, response_bytes
    ) SELECT owner, created.id,
      row_number() OVER (ORDER BY head.entity_kind, head.entity_id)::integer - 1,
      head.entity_kind, head.entity_id,
      CASE WHEN head.deleted THEN 'delete' ELSE 'upsert' END,
      head.revision, head.payload,
      pg_column_size(jsonb_build_object(
        'sequence', created.snapshot_sequence, 'entityKind', head.entity_kind,
        'entityId', head.entity_id,
        'operation', CASE WHEN head.deleted THEN 'delete' ELSE 'upsert' END,
        'revision', head.revision, 'payload', head.payload
      )) + 64
    FROM public.knowledge_entity_heads head CROSS JOIN created_snapshot created
    WHERE head.owner_id = owner AND head.knowledge_base_id = p_knowledge_base_id;
    SELECT * INTO STRICT snapshot FROM public.knowledge_snapshots
      WHERE owner_id = owner AND id = created_snapshot_id;
  ELSE
    SELECT * INTO snapshot FROM public.knowledge_snapshots
      WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
        AND id = p_snapshot_id AND expires_at > clock_timestamp() FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING MESSAGE = 'CURSOR_STALE', ERRCODE = 'P0001';
    END IF;
  END IF;
  WITH candidates AS (
    SELECT item.* FROM public.knowledge_snapshot_items item
    WHERE item.owner_id = owner AND item.snapshot_id = snapshot.id
      AND item.ordinal >= p_after_ordinal
    ORDER BY item.ordinal LIMIT p_limit
  ), measured AS (
    SELECT item.*,
      sum(item.response_bytes) OVER (ORDER BY item.ordinal) AS cumulative_bytes
    FROM candidates item
  ), selected AS (
    SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes - 4096
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'sequence', snapshot.snapshot_sequence, 'entityKind', entity_kind,
      'entityId', entity_id, 'operation', operation,
      'revision', revision, 'payload', payload
    ) ORDER BY ordinal), '[]'::jsonb),
    COALESCE(max(ordinal) + 1, p_after_ordinal)
    INTO changes, next_ordinal FROM selected;
  SELECT EXISTS(SELECT 1 FROM public.knowledge_snapshot_items item
    WHERE item.owner_id = owner AND item.snapshot_id = snapshot.id
      AND item.ordinal >= next_ordinal) INTO has_more;
  IF NOT has_more THEN
    DELETE FROM public.knowledge_snapshots
      WHERE owner_id = owner AND id = snapshot.id;
  END IF;
  RETURN jsonb_build_object(
    'kind', 'snapshot_page', 'snapshotId', snapshot.id,
    'snapshotSequence', snapshot.snapshot_sequence,
    'nextOrdinal', next_ordinal, 'hasMore', has_more, 'changes', changes
  );
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
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'publish_generation', 'knowledgeBaseId', p_knowledge_base_id,
    'generationId', p_generation_id,
    'expectedPublishedGenerationId', p_expected_published_generation_id
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
  IF NOT EXISTS (
    SELECT 1 FROM public.knowledge_generation_memberships membership
    WHERE membership.owner_id = owner
      AND membership.knowledge_base_id = p_knowledge_base_id
      AND membership.generation_id = p_generation_id
  ) THEN
    INSERT INTO public.knowledge_generation_memberships(
      owner_id, knowledge_base_id, generation_id, chunk_id, version_id, ordinal
    )
    SELECT owner, p_knowledge_base_id, p_generation_id, frozen.id,
      frozen.version_id, frozen.manifest_ordinal
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
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_objects
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND deleted_at IS NULL AND verified_at IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_embedding_consents consent
    WHERE consent.owner_id = owner AND consent.state = 'granted'
  ) AND EXISTS (
    SELECT 1 FROM public.knowledge_generation_memberships membership
    WHERE membership.owner_id = owner
      AND membership.knowledge_base_id = p_knowledge_base_id
      AND membership.generation_id = p_generation_id
      AND NOT EXISTS (
        SELECT 1 FROM public.knowledge_chunk_embeddings embedding
        WHERE embedding.owner_id = membership.owner_id
          AND embedding.knowledge_base_id = membership.knowledge_base_id
          AND embedding.generation_id = p_generation_id
          AND embedding.chunk_id = membership.chunk_id
          AND embedding.version_id = membership.version_id
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.knowledge_index_generations
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id
      AND status = 'retained';
  UPDATE public.knowledge_index_generations SET status = 'retained',
    retained_until = clock_timestamp() + interval '7 days'
    WHERE owner_id = owner AND knowledge_base_id = p_knowledge_base_id AND status = 'published';
  UPDATE public.knowledge_index_generations SET status = 'published', published_at = clock_timestamp(),
    retained_until = NULL
    WHERE id = p_generation_id AND owner_id = owner
      AND knowledge_base_id = p_knowledge_base_id;
  UPDATE public.knowledge_bases SET published_generation_id = p_generation_id,
    status = 'ready', revision = p_request_id, updated_at = clock_timestamp()
    WHERE id = p_knowledge_base_id AND owner_id = owner;
  UPDATE public.knowledge_embedding_consents SET rebuild_required = false,
    updated_at = clock_timestamp()
    WHERE owner_id = owner AND state = 'granted';
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
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, p_knowledge_base_id, 'publish_generation', fingerprint, response);
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
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'delete_base', 'knowledgeBaseId', p_knowledge_base_id,
    'expectedPublishedGenerationId', p_expected_published_generation_id
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
    revision = p_request_id, updated_at = clock_timestamp()
    WHERE id = p_knowledge_base_id AND owner_id = owner;
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
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, p_knowledge_base_id, 'delete_base', fingerprint, response);
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
  request_row public.knowledge_requests%ROWTYPE;
  target_base_id varchar;
  fingerprint char(32) := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'cancel_job', 'jobId', p_job_id
  ));
  response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'cancel_job' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT knowledge_base_id INTO target_base_id FROM public.knowledge_jobs
    WHERE id = p_job_id AND owner_id = owner;
  UPDATE public.knowledge_jobs SET state = 'cancelled', lease_token = NULL,
    lease_expires_at = NULL, worker_id = NULL, updated_at = clock_timestamp()
    WHERE id = p_job_id AND owner_id = owner AND state IN ('queued', 'running', 'paused');
  GET DIAGNOSTICS changed = ROW_COUNT;
  response := jsonb_build_object('cancelled', changed = 1);
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (owner, p_request_id, target_base_id, 'cancel_job', fingerprint, response);
  RETURN response;
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
  canonical_references jsonb;
  fingerprint char(32);
  request_row public.knowledge_requests%ROWTYPE;
  references_to_delete jsonb;
  response jsonb;
BEGIN
  IF jsonb_typeof(p_storage_references) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_storage_references) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_storage_references) AS supplied(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_agg(reference ORDER BY reference) INTO canonical_references
    FROM (SELECT DISTINCT jsonb_array_elements_text(p_storage_references) AS reference) refs;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(canonical_references) AS supplied(reference)
    WHERE length(reference) NOT BETWEEN 1 AND 512
      OR reference !~ '^knowledge/' OR position('..' in reference) > 0) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  fingerprint := public.autoforge_knowledge_request_hash(jsonb_build_object(
    'action', 'orphan_cleanup', 'knowledgeBaseId', p_knowledge_base_id,
    'storageReferences', canonical_references
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'orphan_cleanup' OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  SELECT COALESCE(jsonb_agg(object.storage_reference ORDER BY object.storage_reference), '[]'::jsonb)
    INTO references_to_delete
    FROM public.knowledge_objects object
    WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
      AND object.state IN ('authorized', 'orphaned')
      AND object.storage_reference IN (SELECT jsonb_array_elements_text(canonical_references))
      AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions version
        WHERE version.owner_id = owner AND version.knowledge_base_id = p_knowledge_base_id
          AND version.source_object_id = object.id);
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
  removed integer;
  completed_response jsonb;
BEGIN
  IF jsonb_typeof(p_storage_references) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_storage_references) > 100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_storage_references) AS supplied(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(reference ORDER BY reference), '[]'::jsonb)
    INTO canonical_references
    FROM (SELECT DISTINCT jsonb_array_elements_text(p_storage_references) AS reference) refs;
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
  DELETE FROM public.knowledge_objects object
    WHERE object.owner_id = owner AND object.knowledge_base_id = p_knowledge_base_id
      AND object.state IN ('authorized', 'orphaned')
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

-- A trusted worker calls prepare, deletes every returned private Storage object,
-- then calls complete with that exact set. Electron cannot execute either RPC.
CREATE OR REPLACE FUNCTION public.autoforge_knowledge_prepare_base_purge(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  references_to_delete jsonb;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 128
    OR btrim(p_worker_id) = '' OR p_job_id IS NULL OR p_lease_token IS NULL
    OR btrim(p_lease_token) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE id = p_job_id AND kind = 'purge' AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(jsonb_agg(object.storage_reference ORDER BY object.storage_reference), '[]'::jsonb)
    INTO references_to_delete
    FROM public.knowledge_objects object
    WHERE object.owner_id = job.owner_id
      AND object.knowledge_base_id = job.knowledge_base_id
      AND object.deleted_at IS NULL;
  RETURN jsonb_build_object(
    'jobId', job.id, 'storageReferences', references_to_delete
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_base_purge(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_deleted_storage_references jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job public.knowledge_jobs%ROWTYPE;
  expected_count integer;
  supplied_count integer;
  purge_sequence bigint;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 128
    OR btrim(p_worker_id) = '' OR p_job_id IS NULL OR p_lease_token IS NULL
    OR btrim(p_lease_token) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_deleted_storage_references) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_deleted_storage_references) > 10000
    OR pg_column_size(p_deleted_storage_references) > 1048576
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_deleted_storage_references) AS supplied(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE id = p_job_id AND kind = 'purge' AND state = 'running'
      AND worker_id = p_worker_id AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO expected_count FROM public.knowledge_objects object
    WHERE object.owner_id = job.owner_id
      AND object.knowledge_base_id = job.knowledge_base_id
      AND object.deleted_at IS NULL;
  SELECT count(DISTINCT reference) INTO supplied_count
    FROM jsonb_array_elements_text(p_deleted_storage_references) AS supplied(reference);
  IF supplied_count <> expected_count
    OR EXISTS (
      SELECT 1 FROM public.knowledge_objects object
      WHERE object.owner_id = job.owner_id
        AND object.knowledge_base_id = job.knowledge_base_id
        AND object.deleted_at IS NULL
        AND NOT (p_deleted_storage_references ? object.storage_reference)
    ) THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;

  -- This metadata purge is admitted only after the worker reports the exact
  -- Storage set deleted. Content-bearing rows are removed before completion.
  UPDATE public.knowledge_bases SET published_generation_id = NULL
    WHERE owner_id = job.owner_id AND id = job.knowledge_base_id;
  DELETE FROM public.knowledge_entity_heads
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_conflicts
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_documents
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_objects
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_index_generations
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_snapshots
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_changes
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id;
  DELETE FROM public.knowledge_requests
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id
      AND request_id <> job.request_id;
  UPDATE public.knowledge_requests SET action = 'delete_base',
    response = jsonb_build_object('deletionJobId', job.id)
    WHERE owner_id = job.owner_id AND request_id = job.request_id;
  DELETE FROM public.knowledge_jobs
    WHERE owner_id = job.owner_id AND knowledge_base_id = job.knowledge_base_id
      AND id <> job.id;
  UPDATE public.knowledge_bases SET name = '[deleted]', status = 'deleted',
    published_generation_id = NULL,
    updated_at = clock_timestamp()
    WHERE owner_id = job.owner_id AND id = job.knowledge_base_id;
  INSERT INTO public.knowledge_changes(
    owner_id, knowledge_base_id, mutation_id, input_hash,
    entity_kind, entity_id, operation, revision, payload
  ) VALUES (
    job.owner_id, job.knowledge_base_id, job.request_id,
    public.autoforge_knowledge_request_hash(jsonb_build_object(
      'action', 'base_purge_receipt', 'jobId', job.id
    )), 'knowledge_base', job.knowledge_base_id, 'delete', job.request_id, '{}'::jsonb
  ) RETURNING sequence INTO purge_sequence;
  INSERT INTO public.knowledge_tombstones(
    owner_id, knowledge_base_id, entity_kind, entity_id, revision, sequence
  ) VALUES (
    job.owner_id, job.knowledge_base_id, 'knowledge_base',
    job.knowledge_base_id, job.request_id, purge_sequence
  );
  INSERT INTO public.knowledge_sync_floors(
    owner_id, knowledge_base_id, minimum_sequence, updated_at
  ) VALUES (job.owner_id, job.knowledge_base_id, purge_sequence, clock_timestamp())
  ON CONFLICT(owner_id, knowledge_base_id) DO UPDATE SET
    minimum_sequence = excluded.minimum_sequence, updated_at = excluded.updated_at;
  UPDATE public.knowledge_jobs SET state = 'completed', error_code = NULL,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    updated_at = clock_timestamp()
    WHERE owner_id = job.owner_id AND id = job.id
      AND worker_id = p_worker_id AND lease_token = p_lease_token;
  RETURN jsonb_build_object('jobId', job.id, 'completed', true);
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
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_lease_token IS NULL OR btrim(p_lease_token) = '' OR length(p_lease_token) > 128
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_jobs SET state = 'failed', error_code = 'LEASE_EXPIRED',
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
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
    updated_at = clock_timestamp() WHERE id = job.id AND owner_id = job.owner_id;
  RETURN jsonb_build_object('job', jsonb_build_object(
    'id', job.id, 'kind', job.kind, 'entityId', job.entity_id,
    'leaseToken', p_lease_token, 'attempt', job.attempt + 1
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_complete_job(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar,
  p_state varchar, p_error_code varchar
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
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = ''
    OR p_lease_token IS NULL OR btrim(p_lease_token) = ''
    OR p_state IS NULL OR p_state NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  next_state := CASE
    WHEN p_state = 'failed' AND p_error_code = 'TRANSIENT_FAILURE' THEN 'queued'
    ELSE p_state
  END;
  UPDATE public.knowledge_jobs SET state = CASE
      WHEN next_state = 'queued' AND attempt >= 3 THEN 'failed' ELSE next_state END,
    error_code = p_error_code,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    updated_at = clock_timestamp()
    WHERE id = p_job_id AND state = 'running' AND worker_id = p_worker_id
      AND lease_token = p_lease_token
      AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('completed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cancel_claimed_job(
  p_worker_id varchar, p_job_id varchar, p_lease_token varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed integer;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_job_id IS NULL OR btrim(p_job_id) = ''
    OR p_lease_token IS NULL OR btrim(p_lease_token) = '' THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_jobs SET state = 'cancelled', error_code = NULL,
    worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
    updated_at = clock_timestamp()
    WHERE id = p_job_id AND state = 'running' AND worker_id = p_worker_id
      AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('cancelled', true);
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
  p_consent_epoch bigint
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
  SELECT * INTO job FROM public.knowledge_jobs
    WHERE owner_id = p_owner_id AND id = p_job_id
      AND knowledge_base_id = p_knowledge_base_id
      AND kind = 'embedding' AND entity_id = p_generation_id
      AND state = 'running' AND worker_id = p_worker_id
      AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp()
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
    updated_at = clock_timestamp()
    WHERE owner_id = job.owner_id AND id = job.id;
  RETURN jsonb_build_object('ready', true);
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
BEGIN
  INSERT INTO public.knowledge_embedding_consents(owner_id)
    VALUES (owner) ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner;
  RETURN jsonb_build_object(
    'state', consent.state, 'consentEpoch', consent.consent_epoch,
    'rebuildRequired', consent.rebuild_required
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_set_embedding_consent(
  p_caller_user_id varchar, p_request_id varchar, p_enabled boolean
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
    'action', 'set_embedding_consent', 'enabled', p_enabled
  ));
  consent public.knowledge_embedding_consents%ROWTYPE;
  vectors_deleted integer := 0;
  response jsonb;
BEGIN
  IF p_request_id IS NULL OR btrim(p_request_id) = '' OR length(p_request_id) > 128
    OR p_enabled IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  IF p_enabled THEN PERFORM public.autoforge_knowledge_require_cloud(owner); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner::text || ':' || p_request_id, 0));
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id;
  IF FOUND THEN
    IF request_row.action <> 'set_embedding_consent'
      OR request_row.input_hash <> fingerprint THEN
      RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN request_row.response;
  END IF;
  INSERT INTO public.knowledge_embedding_consents(owner_id)
    VALUES (owner) ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  IF p_enabled THEN
    IF consent.state = 'revoking' THEN
      RAISE EXCEPTION USING MESSAGE = 'TRANSIENT_FAILURE', ERRCODE = 'P0001';
    END IF;
    UPDATE public.knowledge_embedding_consents SET state = 'granted',
      consent_epoch = consent_epoch + 1, rebuild_required = p_enabled,
      granted_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE owner_id = owner RETURNING * INTO consent;
  ELSIF consent.state = 'granted' THEN
    UPDATE public.knowledge_embedding_consents SET state = 'revoking',
      consent_epoch = consent_epoch + 1, rebuild_required = p_enabled,
      updated_at = clock_timestamp()
      WHERE owner_id = owner RETURNING * INTO consent;
  END IF;
  IF NOT p_enabled AND consent.state = 'revoking' THEN
    UPDATE public.knowledge_embedding_dispatch_permits SET state = 'expired'
      WHERE owner_id = owner AND state = 'issued';
    IF NOT EXISTS (
      SELECT 1 FROM public.knowledge_embedding_dispatch_permits permit
      WHERE permit.owner_id = owner
        AND permit.state IN ('dispatching', 'started')
    ) THEN
      DELETE FROM public.knowledge_chunk_embeddings WHERE owner_id = owner;
      GET DIAGNOSTICS vectors_deleted = ROW_COUNT;
      UPDATE public.knowledge_embedding_consents SET state = 'revoked',
        revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE owner_id = owner RETURNING * INTO consent;
    END IF;
  END IF;
  response := jsonb_build_object(
    'state', consent.state, 'consentEpoch', consent.consent_epoch,
    'vectorsDeleted', vectors_deleted, 'rebuildRequired', consent.rebuild_required
  );
  INSERT INTO public.knowledge_requests(
    owner_id, request_id, knowledge_base_id, action, input_hash, response
  ) VALUES (
    owner, p_request_id, NULL, 'set_embedding_consent', fingerprint, response
  );
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_issue_embedding_dispatch_permit(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar
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
  ) THEN
    RETURN jsonb_build_object('issued', false);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.knowledge_embedding_dispatch_permits active
    WHERE active.owner_id = owner AND active.purpose = p_purpose
      AND active.request_id = p_request_id
      AND active.attempt_id <> p_attempt_id
      AND active.state IN ('issued', 'dispatching', 'started')
  ) THEN
    RETURN jsonb_build_object('issued', false);
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
    IF permit.state <> 'issued' OR permit.expires_at <= clock_timestamp() THEN
      IF permit.state = 'issued' THEN
        UPDATE public.knowledge_embedding_dispatch_permits SET state = 'expired'
          WHERE owner_id = owner AND permit_id = permit.permit_id;
      END IF;
      RETURN jsonb_build_object('issued', false);
    END IF;
  ELSE
    new_permit_id := 'permit_' || md5(
      owner::text || ':' || p_purpose || ':' || p_request_id || ':'
      || clock_timestamp()::text || ':' || random()::text
    );
    new_expiry := clock_timestamp() + interval '15 seconds';
    INSERT INTO public.knowledge_embedding_dispatch_permits(
      permit_id, owner_id, purpose, request_id, attempt_id, consent_epoch,
      knowledge_base_id, generation_id, chunk_id,
      model, dimensions, configuration_version, expires_at
    ) VALUES (
      new_permit_id, owner, p_purpose, p_request_id, p_attempt_id, p_consent_epoch,
      p_knowledge_base_id, p_generation_id, p_chunk_id,
      p_model, p_dimensions, p_configuration_version, new_expiry
    ) RETURNING * INTO permit;
  END IF;
  RETURN jsonb_build_object(
    'issued', true, 'permitId', permit.permit_id,
    'purpose', permit.purpose, 'requestId', permit.request_id,
    'attemptId', permit.attempt_id,
    'consentEpoch', permit.consent_epoch, 'expiresAt', permit.expires_at,
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
  p_permit_id varchar
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
    END IF;
    RETURN jsonb_build_object('reserved', false);
  END IF;
  IF permit.state = 'issued' THEN
    UPDATE public.knowledge_embedding_dispatch_permits SET state = 'dispatching',
      dispatching_at = clock_timestamp()
      WHERE owner_id = owner AND permit_id = permit.permit_id;
  END IF;
  RETURN jsonb_build_object('reserved', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_mark_embedding_dispatch_started(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar,
  p_permit_id varchar
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
    END IF;
    RETURN jsonb_build_object('started', false);
  END IF;
  UPDATE public.knowledge_embedding_dispatch_permits SET state = 'started',
    started_at = clock_timestamp(), expires_at = clock_timestamp() + interval '2 minutes'
    WHERE owner_id = owner AND permit_id = permit.permit_id;
  RETURN jsonb_build_object('started', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_settle_embedding_dispatch_attempt(
  p_owner_id varchar, p_purpose varchar, p_request_id varchar,
  p_attempt_id integer, p_consent_epoch bigint, p_knowledge_base_id varchar,
  p_generation_id varchar, p_chunk_id varchar,
  p_model varchar, p_dimensions integer, p_configuration_version varchar,
  p_permit_id varchar, p_outcome varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_owner_id);
  permit public.knowledge_embedding_dispatch_permits%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO permit FROM public.knowledge_embedding_dispatch_permits
    WHERE owner_id = owner AND permit_id = p_permit_id FOR UPDATE;
  IF NOT FOUND
    OR permit.purpose IS DISTINCT FROM p_purpose
    OR permit.request_id IS DISTINCT FROM p_request_id
    OR permit.attempt_id IS DISTINCT FROM p_attempt_id
    OR permit.consent_epoch IS DISTINCT FROM p_consent_epoch
    OR permit.knowledge_base_id IS DISTINCT FROM p_knowledge_base_id
    OR permit.generation_id IS DISTINCT FROM p_generation_id
    OR permit.chunk_id IS DISTINCT FROM p_chunk_id
    OR permit.model IS DISTINCT FROM p_model
    OR permit.dimensions IS DISTINCT FROM p_dimensions
    OR permit.configuration_version IS DISTINCT FROM p_configuration_version THEN
    RETURN jsonb_build_object('settled', false);
  END IF;
  IF permit.state = p_outcome THEN
    RETURN jsonb_build_object('settled', true);
  END IF;
  IF permit.state <> 'started' THEN
    RETURN jsonb_build_object('settled', false);
  END IF;
  UPDATE public.knowledge_embedding_dispatch_permits SET state = p_outcome,
    settled_at = clock_timestamp()
    WHERE owner_id = owner AND permit_id = permit.permit_id;
  RETURN jsonb_build_object('settled', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_finalize_embedding_revocation(
  p_caller_user_id varchar, p_request_id varchar
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  request_row public.knowledge_requests%ROWTYPE;
  vectors_deleted integer := 0;
  final_response jsonb;
BEGIN
  SELECT * INTO request_row FROM public.knowledge_requests
    WHERE owner_id = owner AND request_id = p_request_id
      AND action = 'set_embedding_consent' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001'; END IF;
  SELECT * INTO STRICT consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner FOR UPDATE;
  IF consent.state = 'revoked' THEN RETURN request_row.response; END IF;
  IF consent.state <> 'revoking' THEN
    RAISE EXCEPTION USING MESSAGE = 'CONFLICT', ERRCODE = 'P0001';
  END IF;
  UPDATE public.knowledge_embedding_dispatch_permits SET state = 'failed',
    settled_at = clock_timestamp()
    WHERE owner_id = owner AND state = 'dispatching';
  IF EXISTS (
    SELECT 1 FROM public.knowledge_embedding_dispatch_permits permit
    WHERE permit.owner_id = owner
      AND permit.state = 'started'
  ) THEN
    RETURN jsonb_build_object(
      'state', 'revoking', 'consentEpoch', consent.consent_epoch,
      'vectorsDeleted', 0, 'rebuildRequired', false
    );
  END IF;
  DELETE FROM public.knowledge_chunk_embeddings WHERE owner_id = owner;
  GET DIAGNOSTICS vectors_deleted = ROW_COUNT;
  UPDATE public.knowledge_embedding_consents SET state = 'revoked',
    revoked_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE owner_id = owner RETURNING * INTO consent;
  final_response := jsonb_build_object(
    'state', consent.state, 'consentEpoch', consent.consent_epoch,
    'vectorsDeleted', vectors_deleted, 'rebuildRequired', false
  );
  UPDATE public.knowledge_requests SET response = final_response
    WHERE owner_id = owner AND request_id = p_request_id
      AND action = 'set_embedding_consent';
  RETURN final_response;
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_assert_embedding_consent(
  p_owner_id bigint, p_consent_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE consent public.knowledge_embedding_consents%ROWTYPE;
BEGIN
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = p_owner_id;
  RETURN jsonb_build_object(
    'enabled', FOUND AND consent.state = 'granted'
      AND consent.consent_epoch = p_consent_epoch,
    'consentEpoch', COALESCE(consent.consent_epoch, 0)
  );
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

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_store_embedding(
  p_owner_id bigint, p_knowledge_base_id varchar, p_generation_id varchar,
  p_chunk_id varchar, p_version_id varchar, p_consent_epoch bigint, p_model varchar,
  p_dimensions integer, p_configuration_version varchar, p_vector real[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  consent public.knowledge_embedding_consents%ROWTYPE;
  generation public.knowledge_index_generations%ROWTYPE;
BEGIN
  IF p_model <> 'kinfra-text-embedding-0.6b' OR p_dimensions <> 1024
    OR p_configuration_version <> 'autoforge-knowledge-embedding-v1'
    OR cardinality(p_vector) <> 1024
    OR EXISTS (SELECT 1 FROM unnest(p_vector) AS vector_values(value)
      WHERE value::text IN ('NaN', 'Infinity', '-Infinity')) THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = p_owner_id FOR SHARE;
  IF NOT FOUND OR consent.state <> 'granted'
    OR consent.consent_epoch <> p_consent_epoch THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO generation FROM public.knowledge_index_generations
    WHERE owner_id = p_owner_id AND knowledge_base_id = p_knowledge_base_id
      AND id = p_generation_id FOR SHARE;
  IF NOT FOUND OR generation.status NOT IN ('staging', 'ready')
    OR generation.model <> p_model
    OR generation.embedding_dimensions <> p_dimensions
    OR generation.configuration_version <> p_configuration_version THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.knowledge_generation_memberships membership
    WHERE membership.owner_id = p_owner_id
      AND membership.knowledge_base_id = p_knowledge_base_id
      AND membership.generation_id = p_generation_id
      AND membership.chunk_id = p_chunk_id
      AND membership.version_id = p_version_id
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.knowledge_chunk_embeddings(
    owner_id, knowledge_base_id, generation_id, chunk_id, version_id,
    model, dimensions, configuration_version, embedding
  ) VALUES (
    p_owner_id, p_knowledge_base_id, p_generation_id, p_chunk_id, p_version_id,
    p_model, p_dimensions, p_configuration_version, p_vector
  ) ON CONFLICT(owner_id, knowledge_base_id, generation_id, chunk_id)
    DO NOTHING;
  RETURN jsonb_build_object('stored', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_query_terms(p_query varchar)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(array_agg(deduplicated.term ORDER BY deduplicated.first_ordinal), '{}')
  FROM (
    SELECT split.term, min(split.ordinal) AS first_ordinal
    FROM unnest(regexp_split_to_array(
      lower(btrim(p_query)), '[[:space:][:punct:]，。！？；：、（）【】《》“”‘’]+'
    )) WITH ORDINALITY AS split(term, ordinal)
    WHERE split.term <> '' AND char_length(split.term) <= 64
    GROUP BY split.term
    ORDER BY min(split.ordinal)
    LIMIT 16
  ) deduplicated
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_search_keywords(
  p_caller_user_id varchar, p_knowledge_base_ids varchar[], p_query varchar,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  candidates jsonb;
  generations jsonb;
  generation_count integer;
  query_terms text[];
  drift_probe_required boolean := false;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_knowledge_base_ids IS NULL OR cardinality(p_knowledge_base_ids) NOT BETWEEN 1 AND 8
    OR p_query IS NULL OR btrim(p_query) = '' OR length(p_query) > 2000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  query_terms := public.autoforge_knowledge_query_terms(p_query);
  IF cardinality(query_terms) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
    'knowledgeBaseId', current_generation.knowledge_base_id,
    'generationId', current_generation.id,
    'previousGenerationId', previous_generation.id
  ) ORDER BY current_generation.knowledge_base_id), '[]'::jsonb)
  INTO generation_count, generations
  FROM public.knowledge_index_generations current_generation
  LEFT JOIN LATERAL (
    SELECT retained.id FROM public.knowledge_index_generations retained
    WHERE retained.owner_id = owner
      AND retained.knowledge_base_id = current_generation.knowledge_base_id
      AND retained.status = 'retained' AND retained.retained_until > clock_timestamp()
    ORDER BY retained.published_at DESC, retained.id LIMIT 1
  ) previous_generation ON true
  WHERE current_generation.owner_id = owner
    AND current_generation.knowledge_base_id = ANY(p_knowledge_base_ids)
    AND current_generation.status = 'published';
  IF generation_count <> cardinality(p_knowledge_base_ids) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(consent.state = 'granted' AND (
    consent.rebuild_required OR EXISTS (
      SELECT 1 FROM public.knowledge_index_generations generation
      WHERE generation.owner_id = owner
        AND generation.knowledge_base_id = ANY(p_knowledge_base_ids)
        AND generation.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM public.knowledge_chunk_embeddings embedding
          JOIN public.knowledge_generation_memberships membership
            ON membership.owner_id = embedding.owner_id
            AND membership.knowledge_base_id = embedding.knowledge_base_id
            AND membership.generation_id = embedding.generation_id
            AND membership.chunk_id = embedding.chunk_id
            AND membership.version_id = embedding.version_id
          WHERE embedding.owner_id = generation.owner_id
            AND embedding.knowledge_base_id = generation.knowledge_base_id
            AND embedding.generation_id = generation.id
        )
    )
  ), false) INTO drift_probe_required
  FROM public.knowledge_embedding_consents consent WHERE consent.owner_id = owner;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ranked.id, 'knowledgeBaseId', ranked.knowledge_base_id,
    'documentId', ranked.document_id, 'versionId', ranked.version_id,
    'generationId', ranked.generation_id, 'rank', ranked.rank,
    'body', ranked.body, 'coordinates', ranked.coordinates
  ) ORDER BY ranked.rank, ranked.knowledge_base_id, ranked.id), '[]'::jsonb)
  INTO candidates
  FROM (
    SELECT candidate.*, row_number() OVER (
      ORDER BY candidate.literal_position, candidate.ordinal,
        candidate.knowledge_base_id, candidate.id
    )::integer AS rank
    FROM (
      SELECT chunk.id, chunk.knowledge_base_id, chunk.document_id,
        chunk.version_id, chunk.body, chunk.coordinates, chunk.ordinal,
        generation.id AS generation_id,
        (SELECT sum(position(term in lower(chunk.body)))
          FROM unnest(query_terms) AS query(term)) AS literal_position
      FROM public.knowledge_index_generations generation
      JOIN public.knowledge_generation_memberships membership
        ON membership.owner_id = generation.owner_id
        AND membership.knowledge_base_id = generation.knowledge_base_id
        AND membership.generation_id = generation.id
      JOIN public.knowledge_chunks chunk
        ON chunk.owner_id = membership.owner_id
        AND chunk.knowledge_base_id = membership.knowledge_base_id
        AND chunk.id = membership.chunk_id
        AND chunk.version_id = membership.version_id
      JOIN public.knowledge_versions version
        ON version.owner_id = chunk.owner_id
        AND version.knowledge_base_id = chunk.knowledge_base_id
        AND version.id = chunk.version_id AND version.status = 'ready'
      WHERE generation.owner_id = owner
        AND generation.knowledge_base_id = ANY(p_knowledge_base_ids)
        AND generation.status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM unnest(query_terms) AS required(term)
          WHERE position(required.term in lower(chunk.body)) = 0
        )
      ORDER BY literal_position, chunk.ordinal, chunk.knowledge_base_id, chunk.id
      LIMIT least(p_limit * 4, 96)
    ) candidate
    ORDER BY candidate.literal_position, candidate.ordinal,
      candidate.knowledge_base_id, candidate.id
    LIMIT p_limit
  ) ranked;
  RETURN jsonb_build_object(
    'generations', generations,
    'embedding', jsonb_build_object(
      'model', 'kinfra-text-embedding-0.6b', 'dimensions', 1024,
      'configurationVersion', 'autoforge-knowledge-embedding-v1', 'region', 'guangzhou'
    ),
    'driftProbeRequired', drift_probe_required,
    'keywordCandidates', candidates
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_search_vectors(
  p_caller_user_id varchar, p_knowledge_base_ids varchar[],
  p_vector real[], p_model varchar, p_dimensions integer,
  p_configuration_version varchar, p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner bigint := public.autoforge_knowledge_caller(p_caller_user_id);
  consent public.knowledge_embedding_consents%ROWTYPE;
  candidates jsonb;
  generation_count integer;
BEGIN
  PERFORM public.autoforge_knowledge_require_cloud(owner);
  IF p_knowledge_base_ids IS NULL OR cardinality(p_knowledge_base_ids) NOT BETWEEN 1 AND 8
    OR p_model <> 'kinfra-text-embedding-0.6b' OR p_dimensions <> 1024
    OR p_configuration_version <> 'autoforge-knowledge-embedding-v1'
    OR cardinality(p_vector) <> 1024
    OR EXISTS (SELECT 1 FROM unnest(p_vector) AS vector_values(value)
      WHERE value::text IN ('NaN', 'Infinity', '-Infinity'))
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO consent FROM public.knowledge_embedding_consents
    WHERE owner_id = owner;
  IF NOT FOUND OR consent.state <> 'granted' OR consent.rebuild_required THEN
    RAISE EXCEPTION USING MESSAGE = 'FORBIDDEN', ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO generation_count FROM public.knowledge_index_generations
    WHERE owner_id = owner AND knowledge_base_id = ANY(p_knowledge_base_ids)
      AND status = 'published';
  IF generation_count <> cardinality(p_knowledge_base_ids) THEN
    RAISE EXCEPTION USING MESSAGE = 'GENERATION_NOT_READY', ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ranked.id, 'knowledgeBaseId', ranked.knowledge_base_id,
    'documentId', ranked.document_id, 'versionId', ranked.version_id,
    'generationId', ranked.generation_id, 'rank', ranked.rank,
    'body', ranked.body, 'coordinates', ranked.coordinates
  ) ORDER BY ranked.rank, ranked.knowledge_base_id, ranked.id), '[]'::jsonb)
  INTO candidates
  FROM (
    SELECT candidate.*, row_number() OVER (
      ORDER BY candidate.score DESC, candidate.knowledge_base_id, candidate.id
    )::integer AS rank
    FROM (
      SELECT chunk.id, chunk.knowledge_base_id, chunk.document_id,
        chunk.version_id, chunk.body, chunk.coordinates,
        generation.id AS generation_id,
        (
          SELECT sum(embedding.embedding[vector_index] * p_vector[vector_index])
          FROM generate_subscripts(p_vector, 1) AS subscripts(vector_index)
        ) / NULLIF(
          sqrt((SELECT sum(
              embedding.embedding[vector_index] * embedding.embedding[vector_index]
            ) FROM generate_subscripts(p_vector, 1) AS subscripts(vector_index)))
          * sqrt((SELECT sum(p_vector[vector_index] * p_vector[vector_index])
            FROM generate_subscripts(p_vector, 1) AS subscripts(vector_index))),
          0
        ) AS score
      FROM public.knowledge_chunk_embeddings embedding
      JOIN public.knowledge_index_generations generation
        ON generation.owner_id = embedding.owner_id
        AND generation.knowledge_base_id = embedding.knowledge_base_id
        AND generation.id = embedding.generation_id
        AND generation.status = 'published'
      JOIN public.knowledge_generation_memberships membership
        ON membership.owner_id = embedding.owner_id
        AND membership.knowledge_base_id = embedding.knowledge_base_id
        AND membership.generation_id = embedding.generation_id
        AND membership.chunk_id = embedding.chunk_id
        AND membership.version_id = embedding.version_id
      JOIN public.knowledge_chunks chunk
        ON chunk.owner_id = embedding.owner_id
        AND chunk.knowledge_base_id = embedding.knowledge_base_id
        AND chunk.id = embedding.chunk_id
        AND chunk.version_id = embedding.version_id
      WHERE embedding.owner_id = owner
        AND embedding.knowledge_base_id = ANY(p_knowledge_base_ids)
        AND embedding.model = p_model AND embedding.dimensions = p_dimensions
        AND embedding.configuration_version = p_configuration_version
      ORDER BY score DESC NULLS LAST, chunk.knowledge_base_id, chunk.id
      LIMIT p_limit
    ) candidate
    WHERE candidate.score IS NOT NULL
  ) ranked;
  RETURN jsonb_build_object('vectorCandidates', candidates);
END;
$$;

CREATE OR REPLACE FUNCTION public.autoforge_knowledge_cleanup_retention(
  p_worker_id varchar, p_limit integer, p_snapshot_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  pruned_changes integer := 0;
  pruned_tombstones integer := 0;
  pruned_snapshots integer := 0;
  pruned_generations integer := 0;
  pruned_dispatch_permits integer := 0;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000
    OR p_snapshot_limit IS NULL OR p_snapshot_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING MESSAGE = 'INVALID_INPUT', ERRCODE = 'P0001';
  END IF;
  WITH candidates AS (
    SELECT snapshot.owner_id, snapshot.id
    FROM public.knowledge_snapshots snapshot
    WHERE snapshot.expires_at <= clock_timestamp()
    ORDER BY snapshot.expires_at, snapshot.owner_id, snapshot.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_snapshot_limit
  )
  DELETE FROM public.knowledge_snapshots snapshot USING candidates candidate
    WHERE snapshot.owner_id = candidate.owner_id
      AND snapshot.id = candidate.id
      AND snapshot.expires_at <= clock_timestamp();
  GET DIAGNOSTICS pruned_snapshots = ROW_COUNT;
  WITH candidates AS (
    SELECT generation.owner_id, generation.knowledge_base_id, generation.id
    FROM public.knowledge_index_generations generation
    WHERE generation.status = 'retained'
      AND generation.retained_until <= clock_timestamp()
    ORDER BY generation.retained_until, generation.owner_id, generation.id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  DELETE FROM public.knowledge_index_generations generation USING candidates candidate
    WHERE generation.owner_id = candidate.owner_id
      AND generation.knowledge_base_id = candidate.knowledge_base_id
      AND generation.id = candidate.id
      AND generation.status = 'retained'
      AND generation.retained_until <= clock_timestamp();
  GET DIAGNOSTICS pruned_generations = ROW_COUNT;
  DELETE FROM public.knowledge_embedding_dispatch_permits permit
    WHERE (permit.owner_id, permit.permit_id) IN (
      SELECT candidate.owner_id, candidate.permit_id
      FROM public.knowledge_embedding_dispatch_permits candidate
      WHERE (candidate.state IN ('issued', 'expired')
          AND candidate.expires_at <= clock_timestamp())
        OR (candidate.state IN ('completed', 'failed')
          AND candidate.settled_at <= clock_timestamp() - interval '1 hour')
      ORDER BY candidate.expires_at, candidate.owner_id, candidate.permit_id
      LIMIT p_limit
    );
  GET DIAGNOSTICS pruned_dispatch_permits = ROW_COUNT;
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
  RETURN jsonb_build_object(
    'prunedChanges', pruned_changes, 'prunedTombstones', pruned_tombstones,
    'prunedSnapshots', pruned_snapshots, 'prunedGenerations', pruned_generations,
    'prunedDispatchPermits', pruned_dispatch_permits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.autoforge_knowledge_request_user_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_version_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_generation_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_reject_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_generation_membership_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_request_hash(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_caller(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_require_cloud(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_sync(varchar, varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_upload(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_verify_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bigint, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar, varchar, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_job(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_prepare_base_purge(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_base_purge(varchar, varchar, varchar, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cancel_claimed_job(varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_begin_embedding_drift_probe(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, bigint, varchar, varchar, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_get_embedding_consent(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_set_embedding_consent(varchar, varchar, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_issue_embedding_dispatch_permit(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_reserve_embedding_dispatch_attempt(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_mark_embedding_dispatch_started(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_settle_embedding_dispatch_attempt(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_finalize_embedding_revocation(varchar, varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_assert_embedding_consent(bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_claim_embedding_batch(varchar, varchar, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_store_embedding(bigint, varchar, varchar, varchar, varchar, bigint, varchar, integer, varchar, real[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_query_terms(varchar) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_search_keywords(varchar, varchar[], varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_search_vectors(varchar, varchar[], real[], varchar, integer, varchar, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.autoforge_knowledge_cleanup_retention(varchar, integer, integer) FROM PUBLIC, anon, authenticated;

DO $grants$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_bases', 'knowledge_objects', 'knowledge_documents', 'knowledge_versions',
    'knowledge_parser_runs', 'knowledge_blocks', 'knowledge_chunks',
    'knowledge_index_generations', 'knowledge_jobs', 'knowledge_entity_heads',
    'knowledge_changes', 'knowledge_tombstones', 'knowledge_conflicts',
    'knowledge_sync_floors', 'knowledge_upload_authorizations',
    'knowledge_entitlements', 'knowledge_requests', 'knowledge_snapshots',
    'knowledge_snapshot_items', 'knowledge_embedding_consents',
    'knowledge_chunk_embeddings', 'knowledge_generation_memberships',
    'knowledge_embedding_dispatch_permits'
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
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_authorize_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_upload(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_verify_upload(varchar, varchar, varchar, varchar, varchar, bigint, varchar, varchar, bigint, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_push_mutation(varchar, varchar, varchar, varchar, varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_pull_changes(varchar, varchar, bigint, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_full_resync(varchar, varchar, varchar, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_publish_generation(varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_delete_base(varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cancel_job(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_prepare_orphan_cleanup(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_orphan_cleanup(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_job(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_prepare_base_purge(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_base_purge(varchar, varchar, varchar, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_entitlement(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_claim_job(varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_job(varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cancel_claimed_job(varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_begin_embedding_drift_probe(varchar, varchar, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_complete_embedding_generation(varchar, varchar, varchar, bigint, varchar, varchar, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_get_embedding_consent(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_set_embedding_consent(varchar, varchar, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_issue_embedding_dispatch_permit(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_reserve_embedding_dispatch_attempt(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_mark_embedding_dispatch_started(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_settle_embedding_dispatch_attempt(varchar, varchar, varchar, integer, bigint, varchar, varchar, varchar, varchar, integer, varchar, varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_finalize_embedding_revocation(varchar, varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_assert_embedding_consent(bigint, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_claim_embedding_batch(varchar, varchar, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_store_embedding(bigint, varchar, varchar, varchar, varchar, bigint, varchar, integer, varchar, real[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_query_terms(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_search_keywords(varchar, varchar[], varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_search_vectors(varchar, varchar[], real[], varchar, integer, varchar, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.autoforge_knowledge_cleanup_retention(varchar, integer, integer) TO service_role;

COMMIT;
