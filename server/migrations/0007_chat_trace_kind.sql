-- Up Migration

ALTER TABLE chat_traces ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'answer'
    CHECK (kind IN ('answer', 'summary'));

-- Down Migration

ALTER TABLE chat_traces DROP COLUMN kind;
