-- Up Migration

INSERT INTO permissions (code, description)
VALUES ('conversations.debug', '查看和分析会话调试上下文')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'conversations.debug'
FROM roles r
WHERE r.code = 'super_admin'
ON CONFLICT DO NOTHING;

CREATE TABLE debug_cases (
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

CREATE INDEX debug_cases_created_at_idx ON debug_cases (created_at DESC);
CREATE INDEX debug_cases_status_created_idx ON debug_cases (status, created_at DESC);

-- Down Migration

DROP TABLE debug_cases;
DELETE FROM role_permissions WHERE permission_code = 'conversations.debug';
DELETE FROM permissions WHERE code = 'conversations.debug';
