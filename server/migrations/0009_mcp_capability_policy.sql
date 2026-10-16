-- Up Migration

CREATE TABLE mcp_capabilities (
    id VARCHAR(80) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    transport VARCHAR(20) NOT NULL CHECK (transport IN ('stdio', 'http')),
    manifest_key VARCHAR(120) NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL
);

CREATE TABLE mcp_tool_policies (
    capability_id VARCHAR(80) NOT NULL REFERENCES mcp_capabilities(id) ON DELETE CASCADE,
    tool_name VARCHAR(120) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    PRIMARY KEY (capability_id, tool_name)
);

INSERT INTO permissions (code, description) VALUES
    ('mcp.read', '查看 MCP 能力与工具状态'),
    ('mcp.manage', '启停 MCP 能力与工具');

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'super_admin' AND p.code IN ('mcp.read', 'mcp.manage');

INSERT INTO mcp_capabilities (id, name, transport, manifest_key, enabled)
VALUES ('product_catalog', '演示产品目录', 'stdio', 'builtin.mock_products', true);

INSERT INTO mcp_tool_policies (capability_id, tool_name, display_name, enabled) VALUES
    ('product_catalog', 'list_product_categories', '查看产品分类', true),
    ('product_catalog', 'list_products', '查看产品列表', true),
    ('product_catalog', 'get_product_detail', '查看产品规格', true);

-- Down Migration

DROP TABLE mcp_tool_policies;
DROP TABLE mcp_capabilities;
DELETE FROM role_permissions WHERE permission_code IN ('mcp.read', 'mcp.manage');
DELETE FROM permissions WHERE code IN ('mcp.read', 'mcp.manage');
