-- Migration 0005: Full-text search on audit log
-- Creates an FTS5 virtual table for fast search across decision, reason,
-- message_text, llm_response (which includes fun_response as JSON), and
-- extra. Triggers keep the index in sync as rows are inserted (all
-- moderation events) or deleted (daily prune).

CREATE VIRTUAL TABLE IF NOT EXISTS audit_log_fts USING fts5(
  decision,
  reason,
  message_text,
  llm_response,
  extra
);

-- INSERT trigger: add new row to FTS index
CREATE TRIGGER IF NOT EXISTS audit_log_fts_ai AFTER INSERT ON audit_log
BEGIN
  INSERT INTO audit_log_fts(rowid, decision, reason, message_text, llm_response, extra)
  VALUES (new.id, new.decision, new.reason, new.message_text, new.llm_response, new.extra);
END;

-- DELETE trigger: remove row from FTS index (daily prune)
CREATE TRIGGER IF NOT EXISTS audit_log_fts_ad AFTER DELETE ON audit_log
BEGIN
  INSERT INTO audit_log_fts(audit_log_fts, rowid, decision, reason, message_text, llm_response, extra)
  VALUES ('delete', old.id, old.decision, old.reason, old.message_text, old.llm_response, old.extra);
END;

-- UPDATE trigger: replace row in FTS index
CREATE TRIGGER IF NOT EXISTS audit_log_fts_au AFTER UPDATE ON audit_log
BEGIN
  INSERT INTO audit_log_fts(audit_log_fts, rowid, decision, reason, message_text, llm_response, extra)
  VALUES ('delete', old.id, old.decision, old.reason, old.message_text, old.llm_response, old.extra);
  INSERT INTO audit_log_fts(rowid, decision, reason, message_text, llm_response, extra)
  VALUES (new.id, new.decision, new.reason, new.message_text, new.llm_response, new.extra);
END;

-- Seed the FTS index from existing audit rows
INSERT INTO audit_log_fts(rowid, decision, reason, message_text, llm_response, extra)
SELECT id, decision, reason, message_text, llm_response, extra FROM audit_log;
