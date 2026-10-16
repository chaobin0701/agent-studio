-- Up Migration
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('pending', 'queued', 'processing', 'extracted', 'ready', 'failed'));
