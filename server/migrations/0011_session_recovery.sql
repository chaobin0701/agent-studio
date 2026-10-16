-- Up Migration

CREATE TABLE conversation_runs (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_request_id VARCHAR(120) NOT NULL,
    question TEXT NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'expired')),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    error_code VARCHAR(80),
    user_message_id BIGINT REFERENCES conversation_messages(id) ON DELETE SET NULL,
    assistant_message_id BIGINT REFERENCES conversation_messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, client_request_id)
);
CREATE INDEX conversation_runs_conversation_created_idx ON conversation_runs (conversation_id, created_at DESC);
CREATE INDEX conversation_runs_expiry_idx ON conversation_runs (status, expires_at);

-- Down Migration

DROP TABLE conversation_runs;
