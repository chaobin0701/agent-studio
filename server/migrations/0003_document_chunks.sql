-- Up Migration

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
    CHECK (status IN ('queued', 'processing', 'extracted', 'ready', 'failed'));

CREATE TABLE document_chunks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    heading_path TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL CHECK (length(content) > 0),
    source_start_line INTEGER NOT NULL CHECK (source_start_line > 0),
    source_end_line INTEGER NOT NULL CHECK (source_end_line >= source_start_line),
    UNIQUE (document_id, ordinal)
);
CREATE INDEX document_chunks_document_id_idx ON document_chunks (document_id);
