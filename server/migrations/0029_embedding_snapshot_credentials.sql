-- Up Migration
-- Older saved indexes keep their vector space, but resolve the current key
-- from the original configuration so a credential rotation works immediately.
UPDATE knowledge_index_versions v SET embedding_snapshot=v.embedding_snapshot || jsonb_build_object(
  'profileId',p.id,'fingerprint',p.config->>'fingerprint')
FROM embedding_profiles p WHERE p.id=(v.config->>'embeddingProfileId')::bigint
  AND v.embedding_snapshot->>'provider'=p.config->>'provider'
  AND rtrim(v.embedding_snapshot->>'baseUrl','/')=rtrim(p.config->>'baseUrl','/')
  AND v.embedding_snapshot->>'model'=p.config->>'model'
  AND v.embedding_snapshot->>'dimensions'=p.config->>'dimensions'
  AND v.embedding_snapshot->>'profileId' IS NULL;

-- Down Migration
-- Removing the binding would break managed credentials. Keep compatible metadata.
SELECT 1;
