-- Up Migration
CREATE TABLE chat_display_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    public_progress_enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL
);
INSERT INTO chat_display_settings (id, public_progress_enabled) VALUES (1, false);

INSERT INTO permissions (code, description) VALUES
    ('chat.settings.read', '查看访客过程展示设置'),
    ('chat.settings.manage', '调整访客过程展示设置');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'super_admin' AND p.code IN ('chat.settings.read', 'chat.settings.manage');

ALTER TABLE conversation_messages ADD COLUMN progress_events JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Down Migration
ALTER TABLE conversation_messages DROP COLUMN progress_events;
DROP TABLE chat_display_settings;
DELETE FROM role_permissions WHERE permission_code IN ('chat.settings.read', 'chat.settings.manage');
DELETE FROM permissions WHERE code IN ('chat.settings.read', 'chat.settings.manage');
