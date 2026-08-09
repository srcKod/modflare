-- Persist chat identity in the audit log so the admin panel can show a
-- friendly chat handle/title instead of the raw chat_id, and so admins can
-- filter by chat by handle. Both columns are nullable: older rows and DMs
-- (no chat title/username) won't have them.
ALTER TABLE audit_log ADD COLUMN chat_username TEXT;
ALTER TABLE audit_log ADD COLUMN chat_title TEXT;

-- Helpful for filtering the audit log by chat handle.
CREATE INDEX IF NOT EXISTS idx_audit_log_chat_username ON audit_log (chat_username);
