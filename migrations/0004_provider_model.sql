-- Which OpenAI-compatible endpoint and model produced this row. Captured
-- per write so the admin panel can answer "which provider/model produced
-- this error / decision?" even after the operator switches endpoints.
-- Older rows (pre-migration) have NULL here and the UI handles that.
ALTER TABLE audit_log ADD COLUMN provider TEXT;
ALTER TABLE audit_log ADD COLUMN model TEXT;
