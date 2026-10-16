-- Up Migration

DROP TABLE IF EXISTS debug_cases;

-- Down Migration

CREATE TABLE IF NOT EXISTS debug_cases (
    id UUID PRIMARY KEY,
    title VARCHAR(200) NOT NULL DEFAULT '未命名调试案例',
    issue_description TEXT NOT NULL DEFAULT '',
    conversation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    trace_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'analyzing', 'confirmed', 'ignored')),
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    inspected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
