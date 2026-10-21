-- Up Migration
-- Persist the public structured result alongside the assistant message so
-- clients can restore explicitly configured extensions such as follow-ups.
ALTER TABLE conversation_messages
  ADD COLUMN structured JSONB;

-- Down Migration
ALTER TABLE conversation_messages DROP COLUMN structured;
