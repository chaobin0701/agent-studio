-- Up Migration
-- is_default identifies the legacy document endpoint's fallback; it does not
-- exempt a knowledge base from archiving. Preserve its identity and all data.
ALTER TABLE knowledge_bases DROP CONSTRAINT knowledge_bases_check;
