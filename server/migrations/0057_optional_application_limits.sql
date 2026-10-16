-- Up Migration
-- Existing applications keep their explicitly configured limits. New rows opt in.
ALTER TABLE integration_apps ADD COLUMN limit_settings JSONB;
UPDATE integration_apps SET limit_settings=jsonb_build_object(
 'requestsPerMinute',true,'concurrency',true,'dailyRequests',true,'dailyTokenLimit',daily_token_limit IS NOT NULL);
ALTER TABLE integration_apps ALTER COLUMN limit_settings SET NOT NULL;
ALTER TABLE integration_apps ALTER COLUMN limit_settings SET DEFAULT
 '{"requestsPerMinute":false,"concurrency":false,"dailyRequests":false,"dailyTokenLimit":false}'::jsonb;
ALTER TABLE integration_apps ADD CONSTRAINT application_limit_switches_valid CHECK(
 jsonb_typeof(limit_settings)='object' AND
 limit_settings ?& ARRAY['requestsPerMinute','concurrency','dailyRequests','dailyTokenLimit'] AND
 (limit_settings - ARRAY['requestsPerMinute','concurrency','dailyRequests','dailyTokenLimit'])='{}'::jsonb AND
 jsonb_typeof(limit_settings->'requestsPerMinute')='boolean' AND
 jsonb_typeof(limit_settings->'concurrency')='boolean' AND
 jsonb_typeof(limit_settings->'dailyRequests')='boolean' AND
 jsonb_typeof(limit_settings->'dailyTokenLimit')='boolean');

-- Down Migration
ALTER TABLE integration_apps DROP CONSTRAINT application_limit_switches_valid;
ALTER TABLE integration_apps DROP COLUMN limit_settings;
