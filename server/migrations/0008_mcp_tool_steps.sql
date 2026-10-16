-- Up Migration
ALTER TABLE conversation_messages ADD COLUMN tool_steps JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Down Migration
ALTER TABLE conversation_messages DROP COLUMN tool_steps;
