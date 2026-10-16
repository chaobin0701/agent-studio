-- Up Migration

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE document_chunks
  ADD COLUMN embedding vector(1536),
  ADD COLUMN embedding_model VARCHAR(120);

ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_embedding_pair_check
  CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- Exact search is sufficient for the first, small knowledge base. Add an
-- approximate index only after measuring a real latency/recall bottleneck.
