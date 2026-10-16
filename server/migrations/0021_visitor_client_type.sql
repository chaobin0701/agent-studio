-- Up Migration

ALTER TABLE visitor_sessions
  ADD COLUMN client_type VARCHAR(40) NOT NULL DEFAULT 'browser';

CREATE INDEX visitor_sessions_client_type_idx ON visitor_sessions (client_type);

-- Down Migration

DROP INDEX visitor_sessions_client_type_idx;
ALTER TABLE visitor_sessions DROP COLUMN client_type;
