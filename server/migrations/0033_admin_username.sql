-- Up Migration
ALTER TABLE admins ADD COLUMN username VARCHAR(64);
ALTER TABLE admins ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX admins_username_lower_unique ON admins (lower(username));
ALTER TABLE admins ADD CONSTRAINT admins_login_identity_check CHECK (
  (email IS NOT NULL AND length(trim(email)) > 0) OR username IS NOT NULL
);
ALTER TABLE admins ADD CONSTRAINT admins_username_format_check CHECK (
  username IS NULL OR username ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'
);

-- Down Migration
-- Refuse rollback when username-only accounts exist rather than losing them.
ALTER TABLE admins ALTER COLUMN email SET NOT NULL;
ALTER TABLE admins DROP CONSTRAINT admins_username_format_check;
ALTER TABLE admins DROP CONSTRAINT admins_login_identity_check;
DROP INDEX admins_username_lower_unique;
ALTER TABLE admins DROP COLUMN username;
