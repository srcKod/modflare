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
- Scheduled news digest: zero-key engines (Google News RSS incl. zh-CN,
  Hacker News incl. Ask-thread fallback, publisher RSS, arXiv, Hugging Face
  Papers, Semantic Scholar; Tavily/Exa/Jina Search when keyed) feed one LLM
  call per intraday slot (`headlines` / `trending` / `papers` / D1-sourced
  `deep`), posting Telegram-HTML digests to a channel on a `NEWS_SCHEDULE`
  (`9:headlines,12:trending,14:papers,21:deep` style). Domain presets
  (`tech` / `finance` / `science` / `health` / free-form `custom`) plus
  round-robin/random rotation, weekly/monthly rollups, per-slot token
  budgets, cross-run URL dedupe, and full-text archiving per item.
- Digest review console: drafts with a Telegram-HTML editor (live preview,
  save/restore/publish/discard, retry for failed sends), published history
  with reaction analytics (totals, sentiment, velocity, trend) and
  domain/type/slot/date filters, and live runtime settings (schedule,
  domain, topics, language, auto-publish, sponsor footer) without redeploying.
- `NEWS_GNEWS_LOCALE` override: Google News `hl/gl/ceid` locale params as an
  env var (comma list = one fetch per locale, merged + deduped). The locale
  was preset-fixed — `custom` shipped en-US only — so Arabic-language
  Google News sourcing previously required a code change.

### Changed

- **Normalized audit CSV export** (`export.csv`): the model's raw reply is no
  longer a single opaque JSON cell. It is parsed into atomic columns —
  `flag`, `llm_reason`, `fun_response`, and a `parse_status` quality signal
  (`json` / `json_in_prose` / `plain` / `empty`) — so the file can be filtered
  into a clean dataset with a single filter, while the lossless raw reply is
  kept as the last column (`llm_response_raw`). The file now starts with a
  UTF-8 BOM so spreadsheet apps render non-ASCII content correctly.
- **Deep-slot posts are no longer truncated mid-sentence**: the deep prompt
  invites ~5000-char posts, but every slot shared a 3900-char sanitize cap.
  The deep slot now keeps up to `DIGEST_DEEP_BODY_LIMIT` (default `7900`,
  env or panel-settable; all other slots keep 3900) and the chunked sender
  handles the longer body.
- Candidate selection interleaves per engine instead of a global score sort:
  each engine's candidates keep their internal score order and the prompt
  pool fills one item per engine per round (cap unchanged), so scored
  engines (HN points, HF/S2 citations) no longer crowd unscored engines
  (gnews, publisher RSS, Tavily/Exa/Jina) out of the 12-candidate pool.
  Engines that fail or lack a required key contribute nothing and drop out
  naturally; skipped-by-configuration engines surface as an
  `engines_not_configured` audit entry with a set-this-variable hint.
- **Sponsor footer supports named links**: the footer is sanitized with the
  same tag allowlist as post bodies (b/i/u/s/a/code/pre/blockquote,
  http(s)/tg hrefs) instead of fully escaped, so the `digest_sponsor`
  setting accepts inline HTML like
  `Brought to you by <a href="https://…">Name</a>`. Plain text still works;
  markdown `[text](url)` is not interpreted. The footer is appended at send
  time only — stored draft bodies never contain it, and appending the
  identical footer twice is a no-op — so panel publish/retry can no longer
  double the sponsor line.

### Fixed

- Audit table `error`-level badge rendered as a bloated blob: the generic
  page-error rule (`.error`, 20px padding) overrode the pill badge. Renamed
  the row rule to `.row-error`; level badges (`info`, `debug`, `warn`,
  `error`, …) all render as pills now.
- Digest domain rotation ignored the panel's `digest_domain` override: the
  rotation pick read only the env var, so a panel-set `round-robin`/`random`
  engaged the rotation block but pinned every slot to the env preset. The
  pick now uses the settings-layer-resolved domain (panel override wins;
  blank falls through to env).

### Deployment notes

- Apply migration `0007_app_settings.sql` after deploying
  (`npx wrangler d1 migrations apply <db> --remote`). The code degrades
  gracefully (fail-open) if the table is missing, but the Settings tab will
  not persist overrides until the migration is applied.
- Digest migrations `0007_digest_posts.sql`, `0008_digest_extracted_text.sql`,
  `0009_digest_items_post_index.sql` ride the same command (all idempotent).
- Digest Telegram setup: promote the bot in the target channel (Post
  Messages), set `NEWS_TARGET_CHAT_ID`, and for reaction analytics
  re-register the webhook with reaction updates
  (`npm run set-webhook -- --reactions`).

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
