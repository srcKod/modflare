# Telegram Moderation Bot (Cloudflare Worker)

A serverless Telegram bot that automatically moderates group messages **during
a configurable "night hours" window** using **any OpenAI-compatible multimodal
LLM**. When a message contains inappropriate media, suspicious links, or bad
text, the bot deletes it from the group — so admins can sleep while the bot
watches the chat.

**Key features**

- 🚀 **Runs on Cloudflare Workers** — no server to manage, free tier available.
- 🧠 **Any OpenAI-compatible LLM** — swap providers via environment variables
  only (OpenAI, OpenRouter, Groq, Cloudflare Workers AI, …​). No code changes.
- ⏰ **Time-gated** — only active during your chosen window (e.g. 22:00–06:00),
  saving LLM tokens all day.
- 🎯 **Token-safer filtering** — process only messages that have media and/or
  links, not every plain-text message.
- 🛡️ **Video policy** — Telegram-hosted videos from non-admins are deleted
  immediately during active hours, with no wasted LLM inference.
- 😂 **Optional funny reply** (single LLM call) — a kind, harmless joke to the
  poster when something is removed.
- 🔒 **Fail-open** — on any LLM/network error the bot leaves messages untouched.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Behaviors explained](#behaviors-explained)
- [Deployment](#deployment)
- [Local development](#local-development)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
Telegram ──webhook──▶ Worker ──▶ [active period?] ──no──▶ 200 OK (do nothing)
                                  │ yes
                                  ▼
                          [group/supergroup?]  ──no──▶ skip
                                  │ yes
                                  ▼
                          [is sender an admin?]  ──yes──▶ skip (exempt)
                                  │ no
                                  ▼
                          [contains policy video?]  ──yes──▶ deleteMessage
                                  │ no                                (no LLM)
                                  ▼
                          [PROCESS_MODE filter?] ──no──▶ skip (no LLM)
                                  │ yes
                                  ▼
                          [analyze text + images with LLM]
                                  │
                         flag? true ──▶ deleteMessage (+ optional funny reply)
                                  │
                               false ──▶ leave it
```

The bot replies `200 OK` to Telegram immediately and does all the work
(video/deletion/LLM) inside `waitUntil`, so it never blocks or retries the
webhook.

---

## Requirements

- A [Cloudflare account](https://dash.cloudflare.com/) (the free Workers plan
  is enough to run this bot).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- An API key for an OpenAI-compatible multimodal LLM provider:
  - [OpenRouter](https://openrouter.ai/) (e.g. `google/gemma-4-26b-a4b-it`),
  - OpenAI, Groq, or any `/v1/chat/completions`-compatible vendor,
  - or Cloudflare Workers AI via the [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
    (fully OpenAI-compatible, generous free tier).
- [Node.js 18+](https://nodejs.org/) and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/).

---

## Quick start

**1. Get the code**

```bash
git clone https://github.com/srcKod/modflare.git
cd modflare
npm install
```

**2. Configure**

```bash
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Edit `wrangler.toml` — set at minimum:
- `database_id` in `[[d1_databases]]` (create a D1 database first, see [Deployment](#deployment))
- `TIMEZONE`, `START_HOUR`, `END_HOUR`
- `OPENAI_BASE_URL` and `MODEL_NAME`

Edit `.dev.vars` — add your secrets:
- `BOT_TOKEN` (from [@BotFather](https://t.me/BotFather))
- `OPENAI_API_KEY`

**3. Run locally**

```bash
npm run dev
```

Worker starts at `http://127.0.0.1:8787`. To receive real Telegram updates,
expose it with a tunnel and set the webhook (see [Local development](#local-development)).

---

## Configuration

All behavior is driven by configuration. Non-secret values go in
`wrangler.toml` under `[vars]`; **secrets** (tokens/keys) go in `.dev.vars`
locally and in the Cloudflare dashboard / `wrangler secret put` in production.

### Required

| Variable | Purpose | Example |
| :--- | :--- | :--- |
| `BOT_TOKEN` *(secret)* | Telegram bot token from @BotFather | `123456:ABC-...` |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint, no trailing slash | `https://openrouter.ai/api/v1` |
| `OPENAI_API_KEY` *(secret)* | API key for the provider | `sk-or-v1-...` |
| `MODEL_NAME` | Multimodal model id for the provider (used for images) | `google/gemma-4-26b-a4b-it` |
| `TEXT_MODEL` *(optional)* | Cheap/fast text-only model for messages **without** media (falls back to `MODEL_NAME` when unset) | `workers-ai/@cf/zai-org/glm-4.7-flash` |
| `TIMEZONE` | IANA timezone for the active window | `America/New_York` |
| `START_HOUR` | Active window start, 0-23 | `22` |
| `END_HOUR` | Active window end, 0-23 (cross-midnight OK) | `6` |

### Optional

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `PROCESS_MODE` | Which messages to analyze: `all` / `media` / `links` / `media-links` | `media-links` |
| `ADMIN_USERNAMES` | Comma-separated admin usernames (local match, no API call) | *none → use API* |
| `ADMIN_USER_IDS` | Comma-separated admin numeric IDs (immune to username changes) | *none → use API* |
| `ENABLE_FUNRESPONSE` | Post a kind/harmless funny reply after a flagged deletion | `false` |
| `FUNRESPONSE_LANGUAGE` | Language for the funny reply | `English` |
| `FUNRESPONSE_DIALECT` | Optional dialect of the language (e.g. `Egyptian` / `Gulf` / `Levantine` for Arabic) | *none → no dialect hint* |
| `MODERATION_PROMPT` | Custom moderation system prompt | *strict built-in prompt* |
| `WEBHOOK_SECRET_TOKEN` *(secret, optional)* | Validates webhook origin | *none* |
| `LLM_TIMEOUT_MS` | LLM request timeout in milliseconds | `60000` |
| `LLM_MAX_TOKENS` | Cap on LLM output tokens. Bounds slow/reasoning-heavy models | `2048` |
| `LLM_RESPONSE_FORMAT` | Opt-in strict JSON output: set `json` to send `response_format` (model-dependent; some endpoints 400) | *none* |
| `LLM_EXTRA_BODY_JSON` | Arbitrary JSON object merged into the LLM request body for the **image** model (`MODEL_NAME`), e.g. disabling thinking | *none* |
| `TEXT_EXTRA_BODY_JSON` *(optional)* | Same, for the **text** model (`TEXT_MODEL`); falls back to `LLM_EXTRA_BODY_JSON` when unset | *none* |
| `LOG_LEVEL` | Minimum level to persist to the audit log: `debug` / `info` / `warn` / `error` | `info` |
| `LOG_RETENTION_DAYS` | Delete audit rows older than this many days | `30` |
| `LOG_ENABLED` | Master switch for the audit logger (`false` disables all D1 writes) | `true` |
| `ADMIN_PANEL_PATH` | URL prefix for the `/admin` audit-log viewer (in `wrangler.toml` `[vars]`) | `/admin` |
| `ADMIN_PANEL_TOKEN` *(secret, optional)* | Token required to access the admin panel. Without it the panel is disabled entirely | *none* |

> **Choosing a model (latency matters).** The bot works with any OpenAI-
> compatible `/v1/chat/completions` endpoint. Prefer a model that is:
>
> - **Fast & small** — moderation should finish in a few seconds; big or slow
>   models make deletions lag and can exceed `LLM_TIMEOUT_MS`.
> - **No (or minimal) chain-of-thought / reasoning** — reasoning models spend
>   tens of seconds "thinking" before answering. We hit this with
>   `glm-4.7-flash`: its default thinking mode took 35s+ per message and timed
>   out before producing a decision. Avoid reasoning/thinking models here.
> - **Multimodal (optional)** — only needed to moderate photos/videos; for
>   text+links a plain text model is enough.
>
> **Disabling thinking on reasoning models.** Many Workers AI models (GLM,
> Gemma) run a chain-of-thought phase by default that eats latency and output
> tokens — and with a tight `LLM_MAX_TOKENS` it can consume the whole budget,
> producing empty `content` (unparseable, fail-open). Set
> `LLM_EXTRA_BODY_JSON` to the param your provider expects — e.g. GLM or
> Gemma on Cloudflare Workers AI:
> `{"chat_template_kwargs":{"enable_thinking":false}}`, Qwen3:
> `{"enable_thinking":false}`, OpenAI: `{"reasoning_effort":"none"}`.
> The value is merged verbatim into the request body; check your provider's
> docs for the exact param. Verified 2026-08-11 on CF Workers AI: GLM and
> Gemma ignore `{"thinking":{"type":"disabled"}}` but honor
> `chat_template_kwargs.enable_thinking:false` (thinking fully off, ~4×
> faster, ~7× fewer tokens).
>
> Works well: `google/gemma-4-26b-a4b-it` (OpenRouter) or, via Cloudflare AI
> Gateway (set `OPENAI_BASE_URL =
> https://gateway.ai.cloudflare.com/v1/<ACCOUNT>/<GATEWAY>`), `@cf/google/gemma-4-26b-a4b-it`
> or `@cf/meta/llama-4-scout-17b-16e-instruct`.

### Behaviors explained

**Active window (`START_HOUR` / `END_HOUR` / `TIMEZONE`)**
The bot only moderates during this window. Cross-midnight ranges are supported
(`START=22`, `END=6` = active 22:00→06:00). **For 24-hour moderation, set
both to the same value** (e.g. `START=0`, `END=0`). Outside the window every
message passes untouched.

**`PROCESS_MODE`**
Controls which messages reach the LLM, to save tokens during busy periods:

| Mode | Processes |
| :--- | :--- |
| `all` | every message |
| `media` | only messages with a photo / animation / image-document |
| `links` | only messages whose text/caption contains a URL (incl. scheme-less `www.X.com` / `X.com` / `t.me/…`) |
| `media-links` **(default)** | messages with media **or** links |

> Link detection is deliberately broad to avoid letting spam slip through: it
> matches `http(s)://`, `www.` domains, bare domains with a letter TLD
> (`Yahlan.com`, `t.me/joinchat/…`), and emails — but not common filename
> extensions (`report.pdf`, `photo.jpg`).

This filter runs *after* the active-period and admin checks, so it only applies
inside the active window.

**Video policy (fixed, non-admins, active hours)**
Any Telegram-hosted video sent by a **non-admin** during active hours is
**deleted immediately — no LLM call**. Videos are too compute/heavy to decode
inside a Worker and can't be frame-analyzed in useful time by most providers,
so deleting-by-policy is safer and cheaper. Covers:

- `video` messages,
- `video_note` (circular video),
- `document` messages with a `video/*` mime type.

GIFs (`animation`) are **not** affected — they stay on the image path. External
links like YouTube are **text**, not video attachments, so they flow through
the normal link/text path and are only checked as URLs; we rely on the platform
itself for the actual video content.

**Admin exemption**
Admins/creators are never acted upon — their messages are never deleted and
never sent to the LLM. Admin detection is a **local match** against
`ADMIN_USERNAMES` and/or `ADMIN_USER_IDS` (no API cost). If neither is
configured, the bot falls back to one `getChatMember` API call per message.
`ADMIN_USER_IDS` is immune to username changes and is the recommended option.

**Funny reply (`ENABLE_FUNRESPONSE` / `FUNRESPONSE_LANGUAGE` / `FUNRESPONSE_DIALECT`)**
When enabled, a flagged message is deleted **and** the same single LLM call
returns a short, kind, harmless humorous reply in `FUNRESPONSE_LANGUAGE`, which
the bot posts to the group. Optionally set `FUNRESPONSE_DIALECT` to instruct the model
to phrase the reply in a specific regional dialect of that language (e.g. `Egyptian`,
`Gulf`, or `Levantine` for Arabic) — handy when members speak a colloquial dialect
rather than the standard form. The reply is never mean toward the poster, and on
any LLM error it falls back to a safe generic line (so the feature never posts
something rude or breaks the bot).

**Audit logging (D1)**
The bot writes a structured audit trail to a **D1** database — one row per
logged event with timestamp, level, event kind, chat/user, decision, reason,
the moderated message content, and the raw LLM response. This is how you debug
and audit the bot's decisions (and LLM responses/issues) after the fact.

- **Level filtering**: `LOG_LEVEL` controls the minimum severity persisted
  (`debug` for dev, `info`/`warn`/`error` for production).
- **Master switch**: `LOG_ENABLED` (default `true`) turns all D1 audit writes
  on/off. Set it to `false` to disable logging entirely — useful to cut D1
  writes/costs in production, or while you're still standing up the database.
- **Rotation**: `LOG_RETENTION_DAYS` controls how long rows are kept (default
  30 days). A cron trigger prunes expired rows on a schedule, and rows are
  also pruned opportunistically on each write.

To enable it, create a D1 database, bind it in `wrangler.toml`, and apply the
migration:

```bash
npx wrangler d1 create telegram-mod-bot-db
# copy the printed database_id into wrangler.toml [[d1_databases]]
npx wrangler d1 migrations apply telegram-mod-bot-db --remote
```

> **Why D1 and not a file?** Cloudflare Workers have no persistent local
> filesystem — each request may run on a different edge machine and local
> writes vanish. D1 (SQLite) gives durable, queryable storage, which is exactly
> what an audit trail needs: you can run queries like *"all deletions in chat
> X yesterday"* or *"every message flagged as spam"*.
> Read more: [D1](https://developers.cloudflare.com/d1/).

Useful audit queries:

```sql
-- Recent deletions
SELECT * FROM audit_log WHERE event = 'flagged_deleted' ORDER BY ts DESC LIMIT 50;
-- Deletions in a specific chat
SELECT * FROM audit_log WHERE chat_id = <CHAT_ID> AND decision = 'delete' ORDER BY ts DESC;
-- LLM errors (debugging issues)
SELECT * FROM audit_log WHERE level = 'error' ORDER BY ts DESC LIMIT 50;
```

> **Privacy note:** the audit log stores the **content of moderated messages**
> and the **raw LLM responses**. This is what makes it a useful audit trail, but
> it also means user message content lives in your D1 database. Set
> `LOG_LEVEL` higher (e.g. `warn`) and a short `LOG_RETENTION_DAYS` if you want
> to reduce how much content is retained.

---

## Deployment

First-time deploy end-to-end. After this, you only repeat steps 5–6
(`npm run deploy` + re-register webhook if the URL changed).

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

Opens a browser to grant `wrangler` permission to your account. (If you don't
have `wrangler` globally, `npx` will fetch it on first use.)

### 2. Create the D1 database (first time only)

```bash
npx wrangler d1 create telegram-mod-bot-db
```

`wrangler` prints a `database_id`. Paste it into `wrangler.toml`
(`[[d1_databases]] binding = "DB"`). The repo's `wrangler.toml` already
contains a placeholder ID; replace it with the one you got. D1 is free for
the first few GB of storage + reads.

### 3. Apply migrations to the remote DB

```bash
npx wrangler d1 migrations apply telegram-mod-bot-db --remote
```

This runs every file in `migrations/` (in lexical order) against the remote
DB. The `[[d1_databases]].migrations_dir = "migrations"` line in `wrangler.toml`
points `wrangler` at the right directory. Re-run this every time you add a new
migration; already-applied migrations are skipped automatically.

### 4. Set your secrets

Secrets never go in `wrangler.toml` (it's committed). Set them per environment
with `wrangler secret put`:

```bash
npx wrangler secret put BOT_TOKEN              # from @BotFather
npx wrangler secret put OPENAI_API_KEY         # from your LLM provider
npx wrangler secret put WEBHOOK_SECRET_TOKEN   # see step 6 (optional but recommended)
npx wrangler secret put ADMIN_PANEL_TOKEN      # enables /admin (see step 8)
```

`wrangler` prompts for each value (input is hidden). Alternatively, set them
in the Cloudflare dashboard: **Workers & Pages → your worker → Settings →
Variables and Secrets**.

### 5. (Optional) Tune `[vars]` for production

`wrangler.toml [vars]` is committed and is what the deployed worker reads at
startup. Override anything that should differ in production (tighter log
level, a paid model, etc.):

```toml
[vars]
LOG_LEVEL = "warn"                       # quieter than the dev default "debug"
# MODEL_NAME = "gpt-4o-mini"             # swap providers without code changes
```

If a value should be both non-default *and* secret, set it with
`wrangler secret put` instead — secrets override `[vars]` at runtime.

### 6. Deploy

```bash
npm run deploy
```

`wrangler` prints the worker URL, typically
`https://telegram-mod-bot.<your-subdomain>.workers.dev`. Copy it for the next
step.

### 7. Register the webhook

```bash
node scripts/set-webhook.mjs <BOT_TOKEN> https://<your-worker>.workers.dev [SECRET_TOKEN]
```

The optional `SECRET_TOKEN` is what you set in step 4 as `WEBHOOK_SECRET_TOKEN`
— they must match exactly. Verify with:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo" | head -c 300; echo
```

You should see `"url": "https://<your-worker>.workers.dev"` and
`"pending_update_count": 0`.

### 8. Rotating the bot token (after @BotFather /revoke or /token)

`wrangler deploy` does **not** upload `.dev.vars` — `BOT_TOKEN` lives as a
Cloudflare *secret*, so rotating it requires three steps, which the helper
script does in one command:

1. Put the **new** token in `.dev.vars` (`BOT_TOKEN=...`)
2. Run:

```bash
npm run rotate-token            # optionally: npm run rotate-token https://<your-worker>.workers.dev
```

It reads the token from `.dev.vars`, pushes it to the `BOT_TOKEN` secret
(stdin-piped, never echoed to the terminal), re-registers the webhook with the
new token, and verifies via `getWebhookInfo`.

> ⚠️ If you skip this and only deploy, the worker keeps calling the Telegram
> API with the old (revoked) token: moderation still runs and gets logged, but
> `deleteMessage` / fun responses silently fail with `401`.

To unregister the webhook later (e.g. to point the bot at a different worker):

```bash
curl -F "url=" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

### 9. (Optional) Use the admin panel

The `/admin` audit-log viewer is enabled the moment `ADMIN_PANEL_TOKEN` is set
(step 4). Open `https://<your-worker>.workers.dev/admin` in a browser, paste
the token, and the panel returns an HttpOnly signed cookie (12h TTL).

**Panel features:**
- Paginated, filterable table (level, event, decision, chat/user ID, date
  range, free-text search). Hit Enter or Apply to reload.
- **Sortable column headers** — click any column to toggle ascending /
  descending order.
- **Date filters** — two `<input type="date">` fields restrict the view
  to a UTC date range (from / to inclusive).
- **Provider & model** shown in every row (small chip under Reason) and in
  the expanded Details panel — you can always see which LLM produced each
  decision.
- **Inline Details** — click Details to expand a compact property panel
  showing the full timestamp, chat/user identity, original message bubble,
  reason, LLM attribution (provider · model · flag pill), fun_response
  callout (green left-border when present), and a raw JSON toggle.
- **Export CSV** — downloads the current filtered view (up to 5,000 rows).

Change `ADMIN_PANEL_PATH` in `wrangler.toml [vars]` to mount the panel at a
different URL prefix.

### 10. (Optional) Enable the daily log-prune cron

`wrangler.toml` ships with the cron trigger commented out:

```toml
[[triggers]]
crons = ["0 4 * * *"]
```

Uncomment to prune audit rows older than `LOG_RETENTION_DAYS` every day at
04:00 UTC. The cron expression is always UTC; the prune is timezone-agnostic
(it just deletes rows older than N days), so any hour works.

### 11. Add the bot to a group

In Telegram, add your bot to a supergroup and **promote it to admin with
"Delete messages" permission**. Without that, the bot can read messages but
cannot remove them.

> The first deploy takes 30–60 seconds; subsequent deploys are usually
> <10s. Watch real-time logs with `wrangler tail` or in the dashboard under
> **Workers & Pages → your worker → Logs**.

---

## Local development

### 1. Install and configure

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your secrets:
- `BOT_TOKEN` — Telegram bot token
- `OPENAI_API_KEY` — LLM provider key
- `WEBHOOK_SECRET_TOKEN` — (optional) for live webhook testing
- `ADMIN_PANEL_TOKEN` — (optional) to use the admin panel locally

**Non-secret** config (`TIMEZONE`, `START_HOUR`, `MODEL_NAME`, etc.) goes in
`wrangler.toml [vars]`, not `.dev.vars`.

### 2. Create the local D1 database

```bash
npx wrangler d1 create telegram-mod-bot-db
```

Put the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`.
Then apply migrations to the local D1 store:

```bash
npx wrangler d1 migrations apply telegram-mod-bot-db --local
```

Re-run the `migrations apply` step whenever you add a new migration file;
already-applied migrations are skipped.

### 3. Start the dev server

```bash
npm run dev
```

Wrangler starts on `http://127.0.0.1:8787` with a local SQLite-backed D1
(`.wrangler/state/v3/d1/`) and hot-reloads on every save.

**Useful while running:**
- `http://127.0.0.1:8787/admin` — admin panel (requires `ADMIN_PANEL_TOKEN`)
- `wrangler tail` (in another terminal) — live request logs
- D1 inspector: browse to `http://127.0.0.1:8787/cdn-cgi/local/explorer/api/storage/d1/database`

### 4. Test with live Telegram updates

Telegram webhooks require a public HTTPS URL. Expose your dev server with a
tunnel:

```bash
npx wrangler tunnel quick-start http://127.0.0.1:8787
```

The tunnel prints a public `*.trycloudflare.com` URL. Register it with
Telegram:

```bash
node scripts/set-webhook.mjs <BOT_TOKEN> https://<tunnel-url> [SECRET_TOKEN]
```

> This URL changes every time you restart the tunnel — re-run the command
> above each time. For a stable URL, create a named Cloudflare Tunnel.

### npm scripts

| Script | What it does |
| :--- | :--- |
| `npm run dev` | Start local worker on `http://127.0.0.1:8787` |
| `npm run typecheck` | Type-check (`tsc --noEmit`) |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run set-webhook` | Register the Telegram webhook |

### Clean restart (Windows)

`wrangler dev` hot-reloads can leave stale `workerd.exe` processes that serve
cached code. Kill them cleanly:

```bash
./scripts/kill-wrangler-dev.cmd     # kills the dev worker, leaves tunnel alive
./scripts/kill-wrangler-tunnel.cmd  # kills the tunnel (rotates the URL!)
```

Both scripts are idempotent and show what they're killing before they do it.

---

## Project structure

```
.
├── src/
│   ├── index.ts          # Worker entry: webhook → decide → delete → reply
│   ├── llm-client.ts     # OpenAI-compatible chat/completions client + prompt
│   ├── scheduler.ts      # active-period gate + PROCESS_MODE filter
│   ├── telegram-api.ts   # Telegram Bot API helpers + admin/video policy
│   ├── logger.ts         # D1 audit logger (level-filtered, structured)
│   ├── admin.ts          # /admin audit-log viewer (HMAC-signed cookie auth)
│   └── types.ts          # TypeScript types for Env, updates, messages
├── migrations/
│   ├── 0001_audit_log.sql        # D1 schema for the audit trail
│   ├── 0002_user_identity.sql    # adds username + full_name columns
│   ├── 0003_chat_identity.sql    # adds chat_username + chat_title columns
│   └── 0004_provider_model.sql   # adds provider + model columns
├── scripts/
│   ├── set-webhook.mjs           # one-time webhook registration utility
│   ├── kill-wrangler-dev.cmd     # Windows: terminate wrangler dev tree
│   └── kill-wrangler-tunnel.cmd  # Windows: terminate wrangler tunnel tree
├── wrangler.toml         # Worker config (non-secret vars + D1 binding)
├── .dev.vars.example     # local secrets template (copy to .dev.vars)
├── tsconfig.json
├── package.json
└── README.md
```

---

## Limitations

- **Video content is not "analyzed"** — it's deleted by policy during active
  hours. Decoding frames in a Worker isn't feasible (CPU/`VideoDecoder`
  limits), and passing video URLs isn't supported by most OpenAI-compatible
  providers. If you need real video understanding, you'd have to route video to
  a native video-capable provider separately.
- **Non-image documents** (PDF, zip, …​) are not sent to the LLM as media —
  only their caption/file-name text is moderated. Their content is not
  inspected.
- **Latency**: the delete happens *after* the LLM responds (unless it's a
  policy-deleted video), so a flagged message may be visible for 1–3 seconds
  before disappearing. **Best fit:** overnight moderation (admins are asleep,
  no expectation of instant takedown), community/hobby groups, low-to-medium
  traffic chats. **Not ideal for:** real-time compliance filtering,
  high-velocity chats (10+ msg/sec), or scenarios where sub-second removal
  is required.
- **Fail-open**: LLM errors, timeouts, and malformed JSON all default to `SAFE`
  (no deletion) to avoid false positives.
- **Private chats / channels** are ignored; the bot only works in groups and
  supergroups.

---

## Troubleshooting

**Messages aren't being deleted — bot is admin?**
The bot needs the "Delete messages" rights in a supergroup. Add it as admin
with that permission (or use a basic group where bots can delete).

**Webhook returns `ok: false` with "Bad Request: description"?**
Your webhook URL must be HTTPS and publicly reachable; localhost won't work for
a live bot.

**Nothing happens during the night window?**
Check `TIMEZONE`, `START_HOUR`, and `END_HOUR`. Remember `media-links` mode
skips plain text without a link, and admins are exempted. Every decision is
recorded in the [D1 audit log](#configuration) (`audit_log` table) — query it
for the actual reason (`inactive_period`, `admin_exempt`, `skipped_process_mode`,
`flagged_deleted`, `safe`, `moderation_error`, …​). You can also watch live
console output with `wrangler tail` or in the dashboard.

**No audit rows appear?**
The D1 database isn't bound or the migration hasn't been applied. Create it
(`npx wrangler d1 create telegram-mod-bot-db`), add the `database_id` to `wrangler.toml`
[`[[d1_databases]]`], and run
`npx wrangler d1 migrations apply telegram-mod-bot-db --remote`.

**Messages pass through unflagged with `reason: unparseable` or `llm_error:NNN`?**
The LLM endpoint returned empty or an error — the parser is doing the right
thing by failing OPEN (no deletion). Check `wrangler tail` (or
`/tmp/wdev.log` in dev) for `LLM returned 200 but no message content…` /
`LLM reply unparseable: …` / `LLM returned 401` lines that show the exact
upstream response. Common causes:

- The free tier of your provider is rate-limiting or returning empty content
  (e.g. Cline's free Gemma model is unreliable — try a paid model or a
  different provider).
- Wrong `OPENAI_BASE_URL` or expired `OPENAI_API_KEY` (look for
  `llm_error:401` / `llm_error:429` in the audit log).
- The model name isn't available on the endpoint you set.

`parseModeration` in `src/llm-client.ts` is intentionally lenient (accepts
JSON, embedded JSON, or `flag: true` lines) and fails open so a misbehaving
LLM never causes a false deletion.

**`wrangler dev` is acting weird on Windows (auth bypass, stale code)?**
Hot-reloads can leave orphan `workerd.exe` processes around. Run
`./scripts/kill-wrangler-dev.cmd` for a clean restart of just the dev
worker (keeps the tunnel alive).

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request. For
substantial changes, open an issue first to discuss what you'd like to change.

**Areas that could use help:**

- Support for real video analysis via a video-capable provider.
- Analysis of non-image document content (PDF/office parsing).
- Inline keyboard commands for admins to toggle the bot on/off per chat.
- More test coverage (unit tests for the pure logic in `scheduler.ts` and
  `llm-client.ts`).

---

## License

[MIT](./LICENSE)
