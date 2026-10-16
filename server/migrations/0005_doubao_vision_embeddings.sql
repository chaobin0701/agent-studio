-- Up Migration

-- The previous 1536-dimensional embedding space is incompatible with this
-- model. Preserve document records and text chunks; regenerate vectors after
-- deployment using the reindex script.
UPDATE document_chunks SET embedding = NULL, embedding_model = NULL
WHERE embedding IS NOT NULL OR embedding_model IS NOT NULL;

ALTER TABLE document_chunks
  ALTER COLUMN embedding TYPE vector(2048) USING NULL::vector(2048);
