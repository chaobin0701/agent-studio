-- Up Migration
-- The platform is a preset label; the adapter remains OpenAI Compatible for every value.
ALTER TABLE llm_profiles
  ADD COLUMN platform_key VARCHAR(40) NOT NULL DEFAULT 'custom';
ALTER TABLE llm_profiles
  ADD CONSTRAINT llm_profiles_platform_key_check
  CHECK (platform_key IN ('volcengine', 'openai', 'deepseek', 'custom'));

-- Preserve the platform label for profiles created before platform presets were added.
UPDATE llm_profiles
SET platform_key = CASE regexp_replace(base_url, '/+$', '')
  WHEN 'https://ark.cn-beijing.volces.com/api/v3' THEN 'volcengine'
  WHEN 'https://api.openai.com/v1' THEN 'openai'
  WHEN 'https://api.deepseek.com/v1' THEN 'deepseek'
  ELSE 'custom'
END;

-- Down Migration
ALTER TABLE llm_profiles DROP CONSTRAINT llm_profiles_platform_key_check;
ALTER TABLE llm_profiles DROP COLUMN platform_key;
