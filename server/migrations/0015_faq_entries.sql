-- Up Migration
ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'file' CHECK(source_type IN ('file','faq'));
CREATE TABLE faq_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL UNIQUE REFERENCES documents(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE document_blocks DROP CONSTRAINT document_blocks_block_type_check;
ALTER TABLE document_blocks ADD CHECK(block_type IN ('paragraph','code','page','faq'));
