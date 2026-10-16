-- Up Migration
ALTER TABLE documents ADD COLUMN parser_version TEXT;
ALTER TABLE documents ADD COLUMN parser_warnings JSONB NOT NULL DEFAULT '[]';
CREATE TABLE document_blocks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  block_type TEXT NOT NULL CHECK (block_type IN ('paragraph', 'code', 'page')),
  heading_path TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) > 0),
  source_locator JSONB NOT NULL,
  UNIQUE(document_id, ordinal)
);
