-- Up Migration

CREATE TABLE admins (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    password_hash TEXT NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admins_email_lower_unique ON admins (lower(email));

CREATE TABLE roles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    code VARCHAR(120) PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE admin_roles (
    admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_id, role_id)
);
CREATE INDEX admin_roles_role_id_idx ON admin_roles (role_id);

CREATE TABLE role_permissions (
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code VARCHAR(120) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_code)
);
CREATE INDEX role_permissions_permission_code_idx ON role_permissions (permission_code);

CREATE TABLE audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    action VARCHAR(120) NOT NULL,
    target_type VARCHAR(80) NOT NULL,
    target_id VARCHAR(120) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_created_at_idx ON audit_logs (actor_admin_id, created_at DESC);

INSERT INTO permissions (code, description) VALUES
    ('documents.read', '查看资料'),
    ('documents.upload', '上传资料'),
    ('documents.archive', '下架资料'),
    ('documents.reprocess', '重新处理资料'),
    ('conversations.read', '查看访客对话与检索记录'),
    ('admins.manage', '创建与停用管理员'),
    ('roles.manage', '配置角色与权限'),
    ('audit.read', '查看操作记录');

INSERT INTO roles (code, name, is_system)
VALUES ('super_admin', '超级管理员', true);

INSERT INTO role_permissions (role_id, permission_code)
SELECT roles.id, permissions.code
FROM roles CROSS JOIN permissions
WHERE roles.code = 'super_admin';
