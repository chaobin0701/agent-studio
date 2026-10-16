-- Up Migration
ALTER TABLE knowledge_bases ADD COLUMN draft_config JSONB NOT NULL DEFAULT '{}';
CREATE TABLE embedding_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_index_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  knowledge_base_id BIGINT NOT NULL REFERENCES knowledge_bases(id),
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  config JSONB NOT NULL,
  embedding_snapshot JSONB,
  input_snapshot JSONB NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by BIGINT NOT NULL REFERENCES admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE(knowledge_base_id, id)
);
CREATE UNIQUE INDEX knowledge_one_build ON knowledge_index_versions(knowledge_base_id) WHERE status = 'building';
ALTER TABLE knowledge_bases ADD COLUMN active_index_version_id BIGINT;
ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_active_version_fk
  FOREIGN KEY (id, active_index_version_id) REFERENCES knowledge_index_versions(knowledge_base_id, id);
CREATE TABLE index_chunks (
  id BIGINT PRIMARY KEY DEFAULT nextval(pg_get_serial_sequence('document_chunks', 'id')),
  version_id BIGINT NOT NULL REFERENCES knowledge_index_versions(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES documents(id),
  document_title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'parent', 'child', 'faq')),
  parent_chunk_id BIGINT REFERENCES index_chunks(id),
  heading_path TEXT NOT NULL,
  content TEXT NOT NULL,
  search_content TEXT NOT NULL,
  search_vector TSVECTOR NOT NULL,
  source_locator JSONB NOT NULL,
  UNIQUE(version_id, document_id, ordinal)
);
CREATE INDEX index_chunks_version ON index_chunks(version_id);
CREATE INDEX index_chunks_fts ON index_chunks USING gin(search_vector);
CREATE INDEX index_chunks_trgm ON index_chunks USING gin(search_content gin_trgm_ops);
CREATE TABLE chunk_embeddings (
  chunk_id BIGINT PRIMARY KEY REFERENCES index_chunks(id) ON DELETE CASCADE,
  embedding VECTOR NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  CHECK(vector_dims(embedding) = dimensions)
);
