-- Add user identity columns to the audit log so admins can see who sent a
-- message, not just the numeric user_id. Both are nullable because channels
-- (chat.posters without a `from`) and older rows won't have them.
ALTER TABLE audit_log ADD COLUMN username TEXT;
ALTER TABLE audit_log ADD COLUMN full_name TEXT;

-- Helpful for lookups by username (handles, log filtering, future exports).
CREATE INDEX IF NOT EXISTS idx_audit_log_username ON audit_log (username);
