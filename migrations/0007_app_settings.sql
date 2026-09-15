-- Runtime-editable settings (admin panel). Each row SHADOWS the deploy-time
-- env var of the same setting; deleting a row reverts to the env/default value
-- (no redeploy needed to undo a bad change). Keys not present in the code-side
-- SETTING_DEFS allowlist are ignored by the resolver and rejected by the API.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
