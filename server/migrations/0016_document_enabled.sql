-- Up Migration
ALTER TABLE documents ADD COLUMN enabled_for_retrieval BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX documents_retrieval_status_idx ON documents (knowledge_base_id, enabled_for_retrieval, status)
  WHERE archived_at IS NULL;
