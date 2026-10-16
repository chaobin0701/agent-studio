-- Up Migration
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS request_context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS request_context jsonb NOT NULL DEFAULT '{}';

-- Down Migration
ALTER TABLE conversation_runs DROP COLUMN request_context;
ALTER TABLE conversation_messages DROP COLUMN request_context;
