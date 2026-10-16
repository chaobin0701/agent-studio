-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE embedding_profiles
  ADD COLUMN platform_key TEXT NOT NULL DEFAULT 'custom' CHECK (platform_key IN ('volcengine','openai','custom')),
  ADD COLUMN api_key_ciphertext TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE embedding_profiles SET platform_key=CASE
  WHEN rtrim(config->>'baseUrl','/')='https://ark.cn-beijing.volces.com/api/v3' THEN 'volcengine'
  WHEN rtrim(config->>'baseUrl','/')='https://api.openai.com/v1' THEN 'openai'
  ELSE 'custom' END;
UPDATE embedding_profiles SET config=config || jsonb_build_object(
  'profileId',id,'timeoutMs',30000,'fingerprint',encode(digest(concat_ws(E'\n',
    config->>'provider',rtrim(config->>'baseUrl','/'),config->>'model',config->>'dimensions'),'sha256'),'hex'));
UPDATE knowledge_index_versions v SET embedding_snapshot=v.embedding_snapshot || jsonb_build_object(
  'profileId',p.id,'fingerprint',p.config->>'fingerprint')
FROM embedding_profiles p WHERE p.id=(v.config->>'embeddingProfileId')::bigint
  AND v.embedding_snapshot->>'provider'=p.config->>'provider'
  AND rtrim(v.embedding_snapshot->>'baseUrl','/')=rtrim(p.config->>'baseUrl','/')
  AND v.embedding_snapshot->>'model'=p.config->>'model'
  AND v.embedding_snapshot->>'dimensions'=p.config->>'dimensions';
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector;
ALTER TABLE document_chunks
  ADD COLUMN embedding_fingerprint TEXT,
  ADD COLUMN embedding_profile_id BIGINT REFERENCES embedding_profiles(id);
-- The old worker wrote the selected knowledge-base profile's model. Only bind
-- vectors whose model AND dimensions match that explicit profile; unknown
-- legacy vectors stay intact but are not compared with a new vector space.
UPDATE document_chunks c SET embedding_fingerprint=p.config->>'fingerprint',embedding_profile_id=p.id
FROM documents d JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
JOIN embedding_profiles p ON p.id=(kb.draft_config->>'embeddingProfileId')::bigint
WHERE c.document_id=d.id AND c.embedding IS NOT NULL
  AND c.embedding_model=p.config->>'model'
  AND vector_dims(c.embedding)=(p.config->>'dimensions')::int;
CREATE INDEX document_chunks_embedding_space ON document_chunks(embedding_fingerprint) WHERE embedding IS NOT NULL;
INSERT INTO permissions(code,description) VALUES
  ('embedding_profiles.read','查看 Embedding 服务配置'),
  ('embedding_profiles.manage','管理 Embedding 服务与连接测试') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
WHERE r.code='super_admin' AND p.code IN ('embedding_profiles.read','embedding_profiles.manage') ON CONFLICT DO NOTHING;

-- Down Migration
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_chunks WHERE embedding IS NOT NULL AND vector_dims(embedding)<>2048) THEN
    RAISE EXCEPTION 'Cannot downgrade while non-2048-dimensional vectors exist';
  END IF;
END $$;
DROP INDEX document_chunks_embedding_space;
ALTER TABLE document_chunks DROP COLUMN embedding_profile_id,DROP COLUMN embedding_fingerprint;
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(2048) USING embedding::vector(2048);
ALTER TABLE embedding_profiles DROP COLUMN platform_key,DROP COLUMN api_key_ciphertext,DROP COLUMN updated_at;
UPDATE embedding_profiles SET config=config-'profileId'-'fingerprint'-'timeoutMs';
UPDATE knowledge_index_versions SET embedding_snapshot=embedding_snapshot-'profileId'-'fingerprint' WHERE embedding_snapshot IS NOT NULL;
DELETE FROM role_permissions WHERE permission_code IN ('embedding_profiles.read','embedding_profiles.manage');
DELETE FROM permissions WHERE code IN ('embedding_profiles.read','embedding_profiles.manage');
