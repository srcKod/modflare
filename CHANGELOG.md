# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Runtime settings layer: a D1 `settings` table (migration `0007`) where an
  admin-panel override shadows the deploy-time env var of the same setting;
  deleting a row reverts to the env/default without redeploying.
- **Settings tab** in the admin panel (`?tab=settings`): flips the
  moderation master switch, fun-reply, and self-clean toggles live, with a
  source badge (override / env / default), a Reset-to-env button, and every
  change audit-logged (`setting_changed` / `setting_reset`).
- **Moderation master switch** (`ENABLE_MODERATION`, default on): when off,
  group messages pass through unmoderated and each pass-through is logged as
  `moderation_disabled` — the audit trail shows moderation was deliberately
  off, not broken.
- Cross-feature admin API: `GET /api/settings` (defs + effective values +
  source), `POST /api/settings` (validated upsert), `POST /api/settings/reset`
  (delete override). Writes are CSRF-checked; unlisted keys are rejected.

### Fixed

- Audit table `error`-level badge rendered as a bloated blob: the generic
  page-error rule (`.error`, 20px padding) overrode the pill badge. Renamed
  the row rule to `.row-error`; level badges (`info`, `debug`, `warn`,
  `error`, …) all render as pills now.

### Deployment notes

- Apply migration `0007_app_settings.sql` after deploying
  (`npx wrangler d1 migrations apply <db> --remote`). The code degrades
  gracefully (fail-open) if the table is missing, but the Settings tab will
  not persist overrides until the migration is applied.

## [1.0.0] — 2026-09-13

Initial release of Modflare — a serverless Telegram moderation bot on
Cloudflare Workers, powered by any OpenAI-compatible LLM.

### Added

- Group moderation during a configurable night-hours window
  (`TIMEZONE` / `START_HOUR` / `END_HOUR`, cross-midnight and 24h supported).
- LLM verdicts for text and image messages with a fail-open policy: errors,
  timeouts, and unparseable replies never delete a message.
- Product-hosted video deletion policy (videos removed by rule, no LLM cost).
- Optional kind/harmless fun reply after a flagged deletion, with language and
  dialect control (`ENABLE_FUNRESPONSE`, `FUNRESPONSE_LANGUAGE`,
  `FUNRESPONSE_DIALECT`).
- Message filter (`PROCESS_MODE`): all / media / links / media-links to save
  LLM tokens.
- Chat whitelist (`ALLOWED_GROUP_IDS`) and admin exemptions with local
  matching (`ADMIN_USERNAMES` / `ADMIN_USER_IDS`, no API round-trip).
- Bot-message self-clean: messages the bot posts are tracked and deleted
  after a TTL (`ENABLE_SELF_CLEAN`, `SELF_CLEAN_TTL_MINUTES`).
- Structured audit log in D1: level-filtered, retention-pruned, FTS-searchable
  (`LOG_LEVEL`, `LOG_RETENTION_DAYS`, `LOG_ENABLED`).
- Admin panel: token login (HMAC-signed cookie), filterable and sortable audit
  viewer, inline details, CSV export, and a self-clean queue tab
  (`ADMIN_PANEL_TOKEN`, `ADMIN_PANEL_PATH`).
- Cron housekeeping: self-clean sweep every 10 minutes and daily audit prune.
- Modular worker structure: `core/` (telegram client, LLM client, audit
  logger, feature-manifest router, admin shell, config/time helpers),
  `features/` (moderation), `shared/` (bot-message self-clean).
- Unit test suite (vitest) covering config parsing, timezone gating, telegram
  client parsing, the LLM client contract, manifest dispatch, tolerant
  moderation parsing, link detection, and the video policy.
- CI workflow: typecheck + unit tests on every push and pull request
  (Node 24).

### Deployment notes (initial setup)

- Create a D1 database and apply migrations `0001`–`0006`
  (`npx wrangler d1 migrations apply <db> --remote`).
- Set secrets: `BOT_TOKEN`, `OPENAI_API_KEY`; optionally
  `WEBHOOK_SECRET_TOKEN` and `ADMIN_PANEL_TOKEN` (the admin panel is disabled
  unless the token is set).
- Cron triggers: `*/10 * * * *` (self-clean) and `0 4 * * *` (audit prune).
- Register the webhook with `scripts/set-webhook.mjs` after the first deploy.
- See the README quick start for the full end-to-end setup.
