-- Create the audit log table for the moderation bot.
-- Stores one row per logged event (decision, flagged deletion, LLM response, …).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                 -- ISO-8601 UTC timestamp
  level TEXT NOT NULL,              -- debug | info | warn | error
  event TEXT NOT NULL,              -- e.g. flagged_deleted, safe, video_deleted
  chat_id INTEGER,
  user_id INTEGER,
  decision TEXT,                    -- 'delete' | 'keep' | null
  reason TEXT,                      -- model reason / policy reason / error
  message_text TEXT,                -- the moderated message content (may be null)
  llm_response TEXT,                -- raw LLM reply (may be null)
  extra TEXT                        -- JSON-encoded extra fields (may be null)
);

-- Time index for fast retention pruning and time-range queries.
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts);
-- Index for auditing by event type (e.g. all deletions).
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log (event);
-- Composite for 'deletions in chat X' style queries.
CREATE INDEX IF NOT EXISTS idx_audit_log_chat_ts ON audit_log (chat_id, ts);