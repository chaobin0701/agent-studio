-- Up Migration
CREATE TABLE model_accounts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('llm','embedding')),
 name TEXT NOT NULL, platform_key TEXT NOT NULL,
 base_url TEXT NOT NULL, api_key_ciphertext TEXT, secret_ref TEXT,
 key_revision INTEGER NOT NULL DEFAULT 1,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(api_key_ciphertext IS NOT NULL OR secret_ref IS NOT NULL)
);
CREATE TABLE model_deployments (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES model_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('llm','embedding')),
 name TEXT NOT NULL, config JSONB NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE model_plans (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('llm','embedding')),
 name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE model_plan_versions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 plan_id BIGINT NOT NULL REFERENCES model_plans(id),
 version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 config JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 test_signature TEXT, test_result JSONB, tested_at TIMESTAMPTZ,
 published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(plan_id,version)
);
CREATE TABLE model_bindings (
 purpose TEXT PRIMARY KEY CHECK(purpose='customer_support'),
 version_id BIGINT NOT NULL REFERENCES model_plan_versions(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE embedding_profiles ADD COLUMN model_account_id BIGINT REFERENCES model_accounts(id),
 ADD COLUMN model_plan_version_id BIGINT UNIQUE REFERENCES model_plan_versions(id);
-- One account per legacy connection: encrypted values cannot be deduplicated safely.
-- Keep every historical embedding profile ID and vector-space fingerprint.
DO $$
DECLARE r RECORD; a BIGINT; d BIGINT; p BIGINT; v BIGINT; c JSONB;
BEGIN
 FOR r IN SELECT * FROM llm_profiles ORDER BY id LOOP
  INSERT INTO model_accounts(kind,name,platform_key,base_url,api_key_ciphertext,secret_ref,enabled)
   VALUES('llm',r.name||'账户',r.platform_key,r.base_url,r.api_key_ciphertext,CASE WHEN r.api_key_ciphertext IS NULL THEN 'llm' END,r.enabled) RETURNING id INTO a;
  c=jsonb_build_object('model',r.model,'provider','openai-compatible','timeoutMs',r.timeout_ms,
    'contextWindowTokens',r.context_window_tokens,'maxOutputTokens',r.max_output_tokens,'maxRetries',3);
  INSERT INTO model_deployments(kind,account_id,name,config,enabled) VALUES('llm',a,r.name,c,r.enabled) RETURNING id INTO d;
  INSERT INTO model_plans(kind,name) VALUES('llm',r.name) RETURNING id INTO p;
  INSERT INTO model_plan_versions(plan_id,version,status,config,published_at)
   VALUES(p,1,'published',jsonb_build_object('deployments',jsonb_build_array(jsonb_build_object('id',d,'accountId',a,'name',r.name,'baseUrl',r.base_url,'config',c)),'migrated',true),now()) RETURNING id INTO v;
  IF r.enabled AND r.is_default THEN INSERT INTO model_bindings(purpose,version_id) VALUES('customer_support',v); END IF;
 END LOOP;
 FOR r IN SELECT * FROM embedding_profiles ORDER BY id LOOP
  INSERT INTO model_accounts(kind,name,platform_key,base_url,api_key_ciphertext,secret_ref,enabled)
   VALUES('embedding',r.name||'账户',r.platform_key,r.config->>'baseUrl',r.api_key_ciphertext,CASE WHEN r.api_key_ciphertext IS NULL THEN 'embedding:'||COALESCE(r.config->>'secretRef','default') END,r.enabled) RETURNING id INTO a;
  c=(r.config-'profileId'-'fingerprint'-'baseUrl'-'secretRef');
  INSERT INTO model_deployments(kind,account_id,name,config,enabled) VALUES('embedding',a,r.name,c,r.enabled) RETURNING id INTO d;
  INSERT INTO model_plans(kind,name) VALUES('embedding',r.name) RETURNING id INTO p;
  INSERT INTO model_plan_versions(plan_id,version,status,config,published_at)
   VALUES(p,1,'published',jsonb_build_object('deployments',jsonb_build_array(jsonb_build_object('id',d,'accountId',a,'name',r.name,'baseUrl',r.config->>'baseUrl','config',c)),'migrated',true),now()) RETURNING id INTO v;
  UPDATE embedding_profiles SET model_account_id=a,model_plan_version_id=v,name=r.name||' · v1' WHERE id=r.id;
 END LOOP;
END $$;
CREATE FUNCTION protect_published_model_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' THEN RAISE EXCEPTION 'Published model versions are immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER model_versions_immutable BEFORE UPDATE OR DELETE ON model_plan_versions
 FOR EACH ROW EXECUTE FUNCTION protect_published_model_version();
CREATE INDEX model_deployments_account_idx ON model_deployments(account_id);
CREATE INDEX model_versions_plan_idx ON model_plan_versions(plan_id,version DESC);

-- Down Migration
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM model_plan_versions WHERE version>1 OR NOT(config ? 'migrated')) THEN
  RAISE EXCEPTION 'Cannot downgrade after creating managed model versions';
 END IF;
END $$;
DROP TRIGGER model_versions_immutable ON model_plan_versions;
DROP FUNCTION protect_published_model_version;
-- Preserve latest rotated credentials for legacy profiles before dropping bindings.
UPDATE embedding_profiles p SET api_key_ciphertext=a.api_key_ciphertext FROM model_accounts a WHERE a.id=p.model_account_id;
UPDATE llm_profiles p SET api_key_ciphertext=a.api_key_ciphertext FROM model_plans m
 JOIN model_plan_versions v ON v.plan_id=m.id
 JOIN model_accounts a ON a.id=(v.config->'deployments'->0->>'accountId')::bigint
 WHERE m.kind='llm' AND m.name=p.name;
ALTER TABLE embedding_profiles DROP COLUMN model_plan_version_id,DROP COLUMN model_account_id;
DROP TABLE model_bindings,model_plan_versions,model_plans,model_deployments,model_accounts;
