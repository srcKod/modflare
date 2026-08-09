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

```bash
# 1. Get the code
git clone <your-repo-url>
cd telegram-mod-bot

# 2. Install dependencies
npm install

# 3. Create your local secrets file and fill it in
cp .dev.vars.example .dev.vars
#   → edit .dev.vars: BOT_TOKEN, OPENAI_API_KEY (and optionally
#     WEBHOOK_SECRET_TOKEN)

# 4. Create a bot with @BotFather and put its token in .dev.vars

# 5. Run locally
npm run dev
```

For local testing you can expose `wrangler dev` with `ngrok` or `cloudflared`
and point the webhook at that URL temporarily (see
[Local development](#local-development)).

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
| `MODEL_NAME` | Model id for the provider | `google/gemma-4-26b-a4b-it` |
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
| `LLM_TIMEOUT_MS` | LLM request timeout in milliseconds | `15000` |
| `LOG_LEVEL` | Minimum level to persist to the audit log: `debug` / `info` / `warn` / `error` | `info` |
| `LOG_RETENTION_DAYS` | Delete audit rows older than this many days | `30` |
| `LOG_ENABLED` | Master switch for the audit logger (`false` disables all D1 writes) | `true` |
| `ADMIN_PANEL_PATH` | URL prefix for the `/admin` audit-log viewer (in `wrangler.toml` `[vars]`) | `/admin` |
| `ADMIN_PANEL_TOKEN` *(secret, optional)* | Token required to access the admin panel. Without it the panel is disabled entirely | *none* |

> **Cloudflare Workers AI:** set `OPENAI_BASE_URL =
> https://gateway.ai.cloudflare.com/v1/<ACCOUNT>/<GATEWAY>` and any multimodal
> `MODEL_NAME` Cloudflare hosts (e.g. `@cf/meta/llama-4-scout-17b-16e-instruct`).

### Behaviors explained

**Active window (`START_HOUR` / `END_HOUR` / `TIMEZONE`)**
The bot only moderates during this window. Cross-midnight ranges are supported
(`START=22`, `END=6` = active 22:00→06:00). Outside the window every message
passes untouched.

**`PROCESS_MODE`**
Controls which messages reach the LLM, to save tokens during busy periods:

| Mode | Processes |
| :--- | :--- |
| `all` | every message |
| `media` | only messages with a photo / animation / image-document |
| `links` | only messages whose text/caption contains a URL |
| `media-links` **(default)** | messages with media **or** links |

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
npx wrangler d1 create audit_log
# copy the printed database_id into wrangler.toml [[d1_databases]]
npx wrangler d1 migrations apply audit_log --remote
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

This section walks through a full first-time deploy to real Cloudflare
Workers. After the first time, the only step you repeat is
`npm run deploy` (and `set-webhook.mjs` if your worker URL changed).

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

Opens a browser to grant `wrangler` permission to your account. (If you don't
have `wrangler` globally, `npx` will fetch it on first use.)

### 2. Create the D1 database (first time only)

```bash
npx wrangler d1 create audit_log
```

`wrangler` prints a `database_id`. Paste it into `wrangler.toml`
(`[[d1_databases]] binding = "DB"`). The repo's `wrangler.toml` already
contains a placeholder ID; replace it with the one you got. D1 is free for
the first few GB of storage + reads.

### 3. Apply migrations to the remote DB

```bash
npx wrangler d1 migrations apply audit_log --remote
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

To unregister the webhook later (e.g. to point the bot at a different worker):

```bash
curl -F "url=" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
```

### 8. (Optional) Use the admin panel

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

### 9. (Optional) Enable the daily log-prune cron

`wrangler.toml` ships with the cron trigger commented out:

```toml
[[triggers]]
crons = ["0 4 * * *"]
```

Uncomment to prune audit rows older than `LOG_RETENTION_DAYS` every day at
04:00 UTC. The cron expression is always UTC; the prune is timezone-agnostic
(it just deletes rows older than N days), so any hour works.

### 10. Add the bot to a group

In Telegram, add your bot to a supergroup and **promote it to admin with
"Delete messages" permission**. Without that, the bot can read messages but
cannot remove them.

> The first deploy takes 30–60 seconds; subsequent deploys are usually
> <10s. Watch real-time logs with `wrangler tail` or in the dashboard under
> **Workers & Pages → your worker → Logs**.

---

## Local development

### First-time setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in BOT_TOKEN, OPENAI_API_KEY
```

For real Telegram webhook testing, also set `WEBHOOK_SECRET_TOKEN` to a random
string. To use the admin panel locally, also set `ADMIN_PANEL_TOKEN`. See
`.dev.vars.example` for the layout — secrets only; non-secret config lives in
`wrangler.toml [vars]`.

Apply the D1 migrations to your **local** D1 once (and any time you add a
new migration file):

```bash
npx wrangler d1 migrations apply audit_log --local
```

### Start the worker

```bash
npm run dev      # = npx wrangler dev
```

Wrangler boots a local server on `http://127.0.0.1:8787`, applies migrations
to a local SQLite-backed D1 (`.wrangler/state/v3/d1/`), and **hot-reloads** on
every save. Useful endpoints while it's running:

- `http://127.0.0.1:8787/admin` — admin panel (if `ADMIN_PANEL_TOKEN` set)
- `http://127.0.0.1:8787/cdn-cgi/local/explorer/api/storage/d1/database` —
  D1 inspector
- `wrangler tail` (in another terminal) — live request logs

If you only want to test the LLM / admin code paths without Telegram, you can
`curl` the worker directly — no tunnel needed.

### Test with real Telegram updates

The Telegram webhook must point at a **publicly reachable HTTPS URL**, but
`wrangler dev` only listens on localhost. You need a tunnel. Any of these work:

```bash
# Option A: Cloudflare's quick tunnel (no account needed; random *.trycloudflare.com)
npx wrangler tunnel quick-start http://127.0.0.1:8787

# Option B: standalone cloudflared
npx cloudflared tunnel --url http://localhost:8787

# Option C: ngrok
ngrok http 8787
```

The tunnel prints a public URL — point Telegram at it:

```bash
node scripts/set-webhook.mjs <BOT_TOKEN> https://<tunnel-url> [SECRET_TOKEN]
```

> **Note:** `wrangler tunnel quick-start` URLs change every time you start
> it. Re-run `set-webhook.mjs` each time the URL rotates. For a stable URL,
> create a named tunnel: `cloudflared tunnel create my-bot` + a DNS route in
> the Cloudflare dashboard.

### Local admin panel

With `ADMIN_PANEL_TOKEN` set in `.dev.vars`, open
`http://127.0.0.1:8787/admin` and log in with the token. The panel returns
an HttpOnly signed cookie (12h TTL) on success.

> **Note for `wrangler dev` on Windows:** hot-reloads can leave stale
> `workerd.exe` processes around, which may briefly serve cached code or
> skip the admin auth check after a token change. The kill scripts below
> give a clean restart.

### npm scripts

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `wrangler dev` | Start the local worker on :8787 |
| `npm run typecheck` | `tsc --noEmit` | Type-check without emitting |
| `npm run deploy` | `wrangler deploy` | Deploy to Cloudflare |
| `npm run set-webhook` | `node scripts/set-webhook.mjs` | Register the Telegram webhook |

### Stopping the dev server

On Windows, `wrangler dev` can leave stale `workerd.exe` processes around on
hot-reload, which occasionally serve cached code. Two helper scripts in
`scripts/` clean up by **process tree** without touching the other half:

| Script | What it kills | What it keeps |
| :--- | :--- | :--- |
| `scripts/kill-wrangler-dev.cmd` | `npx wrangler dev` + `wrangler.js dev` + `wrangler-dist/cli.js dev` + all `workerd.exe` | The `wrangler tunnel` tree |
| `scripts/kill-wrangler-tunnel.cmd` | `npx wrangler tunnel quick-start` + `wrangler.js tunnel` + `wrangler-dist/cli.js tunnel` | The `wrangler dev` tree + all `workerd.exe` |

Run from Git Bash or Windows cmd:

```bash
./scripts/kill-wrangler-dev.cmd     # leaves the tunnel running
./scripts/kill-wrangler-tunnel.cmd  # only when you want to stop the public URL
```

Each script is idempotent (no error if nothing matches), lists every PID it's
about to kill, and prints a coloured summary: red if a kill failed, green if
the expected state was reached, yellow if nothing was found to kill.

> **Heads up on the tunnel script:** killing the tunnel rotates your
> `*.trycloudflare.com` URL. The next `wrangler tunnel quick-start` gives a
> new one, and you'll need to re-register the webhook with `set-webhook.mjs`.

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
  policy-deleted video), so a flagged photo may be visible for a second or two
  before disappearing.
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
(`npx wrangler d1 create audit_log`), add the `database_id` to `wrangler.toml`
[`[[d1_databases]]`], and run
`npx wrangler d1 migrations apply audit_log --remote`.

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
