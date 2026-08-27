-- Outgoing bot messages awaiting self-cleanup (TTL deletion).
-- Recorded when the bot posts a message (e.g. the fun reply after a flagged
-- deletion); a cron trigger deletes the message via Telegram once it is
-- older than SELF_CLEAN_TTL_MINUTES, then drops the row.
CREATE TABLE IF NOT EXISTS bot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,            -- Telegram message_id to delete
  chat_id INTEGER NOT NULL,               -- Telegram chat the bot posted in
  chat_username TEXT,                     -- chat @username at send time (traceability)
  message TEXT,                           -- bot reply body, capped at 500 chars
  kind TEXT NOT NULL DEFAULT 'default',   -- 'fun' | 'default' (future kinds)
  sent_at TEXT NOT NULL,                  -- ISO-8601 UTC send time
  attempts INTEGER NOT NULL DEFAULT 0     -- failed deletion attempts so far
);

-- Cron cleanup selects rows by sent_at cutoff.
CREATE INDEX IF NOT EXISTS idx_bot_messages_sent_at ON bot_messages (sent_at);
