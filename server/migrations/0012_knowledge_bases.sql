-- Up Migration
CREATE TABLE knowledge_bases (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(120) NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT false,
    enabled_for_chat BOOLEAN NOT NULL DEFAULT false,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT is_default OR archived_at IS NULL)
);
CREATE UNIQUE INDEX knowledge_bases_one_default ON knowledge_bases (is_default) WHERE is_default;
INSERT INTO knowledge_bases (name, description, is_default, enabled_for_chat)
VALUES ('默认知识库', '兼容原有资料和访客问答', true, true);
ALTER TABLE documents ADD COLUMN knowledge_base_id BIGINT REFERENCES knowledge_bases(id) ON DELETE RESTRICT;
UPDATE documents SET knowledge_base_id = (SELECT id FROM knowledge_bases WHERE is_default);
ALTER TABLE documents ALTER COLUMN knowledge_base_id SET NOT NULL;
CREATE INDEX documents_knowledge_base_id_idx ON documents (knowledge_base_id, id);
INSERT INTO permissions (code, description) VALUES ('knowledge_bases.manage', '创建、配置和归档知识库');
INSERT INTO role_permissions (role_id, permission_code)
SELECT id, 'knowledge_bases.manage' FROM roles WHERE code = 'super_admin';
