-- Up Migration
ALTER TABLE integration_apps ADD COLUMN daily_token_limit bigint CHECK(daily_token_limit BETWEEN 1 AND 1000000000000);
ALTER TABLE integration_calls ADD COLUMN input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN output_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN unknown_model_calls integer NOT NULL DEFAULT 0;
ALTER TABLE integration_calls ALTER COLUMN total_tokens TYPE bigint;

-- One ledger entry per model attempt, including failed requests and asynchronous summaries.
CREATE TABLE integration_model_calls (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES integration_calls(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES integration_apps(id),
  purpose varchar(20) NOT NULL CHECK(purpose IN ('planner','answer','summary','legacy')),
  model varchar(200),
  usage_status varchar(20) NOT NULL CHECK(usage_status IN ('reserved','actual','unknown','legacy')),
  reserved_tokens bigint NOT NULL CHECK(reserved_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  input_tokens bigint,
  output_tokens bigint,
  quota_day date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Shanghai')::date,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_model_usage ON integration_model_calls(app_id, quota_day);
CREATE INDEX integration_model_call ON integration_model_calls(call_id);
-- Preserve previous known totals; label their incomplete accounting explicitly.
INSERT INTO integration_model_calls(id,call_id,app_id,purpose,usage_status,reserved_tokens,total_tokens,quota_day,settled_at,created_at)
SELECT id,id,app_id,'legacy','legacy',0,total_tokens,(created_at AT TIME ZONE 'Asia/Shanghai')::date,finished_at,created_at
FROM integration_calls WHERE total_tokens > 0;

-- Down Migration
DROP TABLE integration_model_calls;
ALTER TABLE integration_calls DROP COLUMN input_tokens, DROP COLUMN output_tokens, DROP COLUMN unknown_model_calls;
ALTER TABLE integration_apps DROP COLUMN daily_token_limit;
-- Keep the widened total_tokens column to avoid truncating accumulated usage on rollback.
