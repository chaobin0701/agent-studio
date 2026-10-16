-- Up Migration
ALTER TABLE admins ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);

-- Down Migration
ALTER TABLE admins DROP COLUMN session_version;
