-- Up Migration

CREATE TABLE visitor_sessions (
    id UUID PRIMARY KEY,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    visitor_session_id UUID NOT NULL REFERENCES visitor_sessions(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL DEFAULT '新对话',
    summary TEXT NOT NULL DEFAULT '',
    summary_through_message_id BIGINT,
    busy_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversations_visitor_updated_idx ON conversations (visitor_session_id, updated_at DESC);

CREATE TABLE conversation_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(12) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    refused BOOLEAN,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversation_messages_conversation_id_idx ON conversation_messages (conversation_id, id);

CREATE TABLE chat_traces (
    id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id BIGINT REFERENCES conversation_messages(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    model VARCHAR(120),
    raw_model_output TEXT,
    final_answer TEXT,
    refused BOOLEAN,
    status VARCHAR(20) NOT NULL CHECK (status IN ('completed', 'failed')),
    error_code VARCHAR(80),
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    duration_ms INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_traces_created_at_idx ON chat_traces (created_at DESC);
CREATE INDEX chat_traces_conversation_id_idx ON chat_traces (conversation_id, created_at DESC);

-- Down Migration

DROP TABLE chat_traces;
DROP TABLE conversation_messages;
DROP TABLE conversations;
DROP TABLE visitor_sessions;
