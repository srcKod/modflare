-- Migration 0007: News digest (posts, published items, interaction stats).
--
-- digest_posts  : one row per digest run slot (draft, published, discarded, failed)
-- digest_items  : every item ever included in a published digest (URL dedupe)
-- digest_post_stats : insert-only interaction stats (reactions, member counts)

CREATE TABLE IF NOT EXISTS digest_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL,                 -- daily:"2026-09-13T09" weekly:"2026-W37" monthly:"2026-09"
  type TEXT NOT NULL DEFAULT 'daily',     -- daily | weekly | monthly
  run_at TEXT NOT NULL,                   -- ISO-8601 UTC
  mode TEXT NOT NULL,                     -- news | papers | both
  domain TEXT,                            -- NEWS_DOMAIN preset used
  target_chat_id TEXT NOT NULL,           -- channel/group the digest belongs to
  title TEXT,                             -- digest headline (from LLM JSON)
  body TEXT,                              -- current post text (LLM original or admin edit)
  body_original TEXT,                     -- untouched LLM output (Restore action)
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | published | discarded | failed
  provider TEXT,                          -- LLM endpoint (attribution)
  model TEXT,                             -- LLM model (attribution)
  edited_at TEXT,                         -- last admin save (null if never edited)
  published_at TEXT,                      -- when approved & sent
  message_id INTEGER,                     -- Telegram message_id (published only)
  error TEXT                              -- failure reason when status=failed
);

-- Idempotency: one row per (slot, chat) — a re-run in the same slot is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_posts_slot
  ON digest_posts (slot_key, target_chat_id);
CREATE INDEX IF NOT EXISTS idx_digest_posts_status ON digest_posts (status, run_at);

-- Items ever published: cross-run URL dedupe + weekly/monthly synthesis input.
CREATE TABLE IF NOT EXISTS digest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL UNIQUE,          -- sha-256 hex of the normalized URL
  url TEXT NOT NULL,
  title TEXT,
  source TEXT,                            -- publisher / engine name
  digest_post_id INTEGER REFERENCES digest_posts(id),
  published_at TEXT                       -- set only when the digest goes out
);
CREATE INDEX IF NOT EXISTS idx_digest_items_published ON digest_items (published_at);

-- Interaction stats: insert-only time series. A new row is written only when the
-- aggregate actually changed (JSON-hash compare) to bound D1 writes.
-- digest_post_id NULL = chat-level metric (e.g. channel member count).
CREATE TABLE IF NOT EXISTS digest_post_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_post_id INTEGER REFERENCES digest_posts(id),
  metric TEXT NOT NULL,                   -- 'reactions' | 'channel_members'
  value INTEGER,                          -- total reaction count / member count
  detail_json TEXT,                       -- per-emoji breakdown {"👍": 12, "🔥": 3}
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_stats_post
  ON digest_post_stats (digest_post_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_digest_stats_metric
  ON digest_post_stats (metric, captured_at);
