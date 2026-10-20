-- Up Migration
ALTER TABLE agent_interactions DROP CONSTRAINT agent_interactions_status_check;
ALTER TABLE agent_interactions ADD CONSTRAINT agent_interactions_status_check
 CHECK(status IN ('pending','answered','skipped','approved','rejected','expired','cancelled'));

-- Down Migration
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM agent_interactions WHERE status='skipped') THEN
  RAISE EXCEPTION 'Skipped interaction history exists; retain it before reverting';
 END IF;
END $$;
ALTER TABLE agent_interactions DROP CONSTRAINT agent_interactions_status_check;
ALTER TABLE agent_interactions ADD CONSTRAINT agent_interactions_status_check
 CHECK(status IN ('pending','answered','approved','rejected','expired','cancelled'));
