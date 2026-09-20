-- Migration 0008: persist raw engine/extraction text per selected item.
--
-- digest_items.extracted_text holds the FULL text an engine returned for an
-- item BEFORE any LLM summarization: the engine's own snippet, or — when
-- NEWS_FETCH_FULLTEXT=true — the article text fetched from the URL
-- (native HTMLRewriter, Jina Reader fallback). Stored verbatim so a future
-- feature can re-summarize, run Q&A against the source, or audit what the LLM
-- actually saw, without re-fetching.
--
-- NULL when NEWS_FETCH_FULLTEXT is off (no extraction ran) or when the item
-- came from a history rollup (it only has the already-summarized post).

ALTER TABLE digest_items ADD COLUMN extracted_text TEXT;
