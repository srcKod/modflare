-- Migration 0009: index the digest_items → digest_posts join.
--
-- loadDeepSource joins digest_items to digest_posts on digest_post_id on
-- every deep slot, and the orphaned-items prune deletes by digest_post_id.
-- Without an index both degrade to full scans as the URL registry grows
-- (the registry is append-mostly by design for cross-run dedupe).
-- Existing covering index (idx_digest_items_published on published_at) does
-- not serve the join column.

CREATE INDEX IF NOT EXISTS idx_digest_items_post
  ON digest_items (digest_post_id);
