/**
 * Core type definitions: Worker environment bindings and generic Telegram
 * update/message shapes. Feature-specific types live with their features
 * (e.g. features/moderation/types.ts).
 */

/** Environment bindings injected by Wrangler / Cloudflare. */
export interface Env {
  /** Telegram bot token (secret). */
  BOT_TOKEN: string;
  /** OpenAI-compatible base URL, no trailing slash, e.g. `https://openrouter.ai/api/v1`. */
  OPENAI_BASE_URL: string;
  /** API key for the chosen provider (secret). */
  OPENAI_API_KEY: string;
  /** Model identifier, e.g. `google/gemini-2.0-flash-lite-preview-09-16`. */
  MODEL_NAME: string;
  /**
   * Optional text-only model used for messages WITHOUT media (no image parts
   * reach the LLM). Lets cheap/fast text models (e.g. GLM-flash) handle the
   * common spam/link case while MODEL_NAME (multimodal, e.g. Gemma) handles
   * images. Falls back to MODEL_NAME when unset.
   */
  TEXT_MODEL?: string;
  /** IANA timezone for "night hours", e.g. `America/New_York`. */
  TIMEZONE: string;
  /** Start of active period, 0-23. */
  START_HOUR: number;
  /** End of active period, 0-23. Handles cross-midnight ranges. */
  END_HOUR: number;
  /** Optional custom moderation system prompt. Defaults to a strict prompt. */
  MODERATION_PROMPT?: string;
  /** Optional Telegram webhook secret token to validate request origin. */
  WEBHOOK_SECRET_TOKEN?: string;
  /**
   * Which messages to send to the LLM. One of:
   *   'all'        - every message
   *   'media'      - only messages with photos/videos/animations/documents
   *   'links'      - only messages containing URLs
   *   'media-links'- only messages with media OR links (recommended default)
   */
  PROCESS_MODE?: string;
  /**
   * Optional comma-separated admin usernames (with or without leading '@').
   * When set, admin detection is decided from the username only and the
   * getChatMember API call is skipped, saving a network round-trip per
   * message. When unset, the API call is used instead.
   */
  ADMIN_USERNAMES?: string;
  /**
   * Optional comma-separated admin numeric user IDs. Companion to
   * ADMIN_USERNAMES; immune to username changes. When either is set, the
   * getChatMember API call is skipped. When neither is set, the API is used.
   */
  ADMIN_USER_IDS?: string;
  /**
   * Optional comma-separated numeric chat IDs the bot is allowed to moderate.
   * Supergroup/group IDs are negative. When set, any message from a chat not
   * in the list is ignored before any LLM/media/admin work. Unset or empty =
   * allow all groups (backward compatible / fail-open).
   */
  ALLOWED_GROUP_IDS?: string;
  /**
   * Moderation master switch (env fallback layer). 'false' = moderation is
   * off: group messages pass through untouched (each skip is logged). Can
   * also be flipped at runtime from the admin panel's Settings tab (D1
   * `settings` row `moderation_enabled`, which SHADOWS this var).
   */
  ENABLE_MODERATION?: string;
  /**
   * When true and a message is flagged+deleted, post a kind, harmless funny
   * reply to the group (in the chat's language).
   */
  ENABLE_FUNRESPONSE?: string;
  /** Language for the funny reply when ENABLE_FUNRESPONSE is on. Defaults to English. */
  FUNRESPONSE_LANGUAGE?: string;
  /**
   * Optional dialect/dialect of FUNRESPONSE_LANGUAGE to use for the funny
   * reply (e.g. for Arabic: 'Egyptian', 'Gulf', 'Levantine', 'Standard').
   * When set, the LLM is asked to phrase the reply in this dialect. When
   * unset, no dialect hint is sent and the model falls back to the audience.
   */
  FUNRESPONSE_DIALECT?: string;
  /**
   * When 'true', outgoing bot messages (e.g. fun replies) are tracked in
   * the bot_messages table and deleted by the cron trigger after
   * SELF_CLEAN_TTL_MINUTES. Unset or anything else = disabled (default).
   */
  ENABLE_SELF_CLEAN?: string;
  /**
   * Minutes a tracked bot message lives before the cron deletes it.
   * Defaults to 60. Telegram refuses to delete messages older than ~48h.
   */
  SELF_CLEAN_TTL_MINUTES?: string;
  /** Optional LLM request timeout in ms. Defaults to 60000. */
  LLM_TIMEOUT_MS?: string;
  /** Optional cap on LLM output tokens. Bounds reasoning-heavy models. */
  LLM_MAX_TOKENS?: string;
  /** Optional structured output: set `json` to send response_format json_object (model-dependent). */
  LLM_RESPONSE_FORMAT?: string;
  /** Optional arbitrary JSON object merged into the LLM request body (provider/model-specific params). */
  LLM_EXTRA_BODY_JSON?: string;
  /**
   * Optional arbitrary JSON object merged into the request body when the
   * TEXT_MODEL handles the message (media-free). Falls back to
   * LLM_EXTRA_BODY_JSON when unset, so both models get the same provider
   * params unless overridden here.
   */
  TEXT_EXTRA_BODY_JSON?: string;
  /** Optional max media download bytes. Defaults to 20MB. */
  MAX_MEDIA_BYTES?: string;

  /**
   * D1 database binding for the audit log. When present, the bot writes
   * structured audit rows (decisions, LLM responses) here. When absent,
   * logging is a no-op and moderation still works.
   */
  DB?: D1Database;
  /**
   * Minimum log level to persist: 'debug' | 'info' | 'warn' | 'error'.
   * Defaults to 'info'.
   */
  LOG_LEVEL?: string;
  /**
   * Master switch for the audit logger: 'true'/'1'/'yes' enables it,
   * anything else (or unset) enables it too. Set to 'false' to disable all
   * D1 audit writes. Defaults to enabled.
   */
  LOG_ENABLED?: string;
  /**
   * Secret token for the admin panel login. When set, the panel requires it
   * (via a cookie set after a login form POST). When unset, the panel is
   * disabled entirely (no /admin route). Keep it strong — it walls off the
   * audit log.
   */
  ADMIN_PANEL_TOKEN?: string;
  /**
   * URL path prefix for the admin panel. Defaults to '/admin'. Setting a
   * random value (e.g. '/secure-admin-x123') hides the panel from casual
   * discovery. Combined with ADMIN_PANEL_TOKEN for defense in depth.
   */
  ADMIN_PANEL_PATH?: string;
  /** Token TTL for the admin panel cookie, in seconds. Defaults to 43200 (12h). */
  ADMIN_PANEL_TTL?: string;
  /**
   * Retention for audit logs, in days. Rows older than this are pruned by
   * the scheduled cron job (and opportunistically on each write).
   * Defaults to 30.
   */
  LOG_RETENTION_DAYS?: string;
  /* ----------------------------------------------------------------
   * News digest (FEATURE_PLAN.md) — all optional with preset defaults
   * ---------------------------------------------------------------- */

  /** Master switch: 'true' enables the digest cron gate. Default off. */
  ENABLE_NEWS_DIGEST?: string;
  /** Content-domain preset: tech | tech-zh | finance | science | health | custom. Default tech. */
  NEWS_DOMAIN?: string;
  /** What to include: news | papers | both. Default news. */
  NEWS_MODE?: string;
  /** Comma-separated topic queries. Overrides the preset. */
  NEWS_TOPICS?: string;
  /**
   * News engine override: gnews | hn | rss | tavily | exa.
   * Default: the preset's engine list. Comma list = additive engines.
   */
  NEWS_ENGINE?: string;
  /** Explicit publisher-RSS URLs (comma-separated) for engine `rss` / additive feeds. */
  NEWS_RSS_FEEDS?: string;
  /** arXiv categories (comma list → cat:X OR cat:Y). Default from preset. */
  NEWS_ARXIV_CATEGORIES?: string;
  /** Trusted-source domain allowlist applied to all engine results. Empty = preset. */
  NEWS_INCLUDE_DOMAINS?: string;
  /** HN quality threshold: numericFilters=points>N. Default 25. */
  NEWS_MIN_POINTS?: string;
  /** Items the LLM selects per digest. Default 5 (cap 8 for free-plan budgets). */
  NEWS_MAX_ITEMS?: string;
  /** 'true' = fetch + extract full text for the top items. Default off (token/CPU frugal). */
  NEWS_FETCH_FULLTEXT?: string;
  /** Target channel/group (@username or -100… id). Bot must be an admin there. */
  NEWS_TARGET_CHAT_ID?: string;
  /** Static display name for the target chat (panel confirms/headers). Unset = show the id. */
  NEWS_TARGET_CHAT_NAME?: string;
  /** 'true' enables the weekly Roundup (built from the week's published items). */
  NEWS_ENABLE_WEEKLY?: string;
  /** Day of week for the Roundup, 0=Sunday. Default 0. */
  NEWS_WEEKLY_DAY?: string;
  /** 'true' enables the monthly Deep Dive. */
  NEWS_ENABLE_MONTHLY?: string;
  /** Day of month for the Deep Dive. Default 1. */
  NEWS_MONTHLY_DAY?: string;
  /** Output language of the digest post. Default English. */
  NEWS_LANGUAGE?: string;
  /** Optional dialect hint (e.g. "Standard" / "Levantine" for Arabic). */
  NEWS_DIALECT?: string;
  /**
   * 'true' = publish directly at the configured time.
   * 'false' (default) = store as a draft and wait for admin approval.
   */
  NEWS_AUTO_PUBLISH?: string;
  /**
   * Chat that gets "draft ready" notices. Unset = DM every id in
   * ADMIN_USER_IDS (silent failures for admins who never started the bot).
   */
  NEWS_DRAFT_NOTIFY_CHAT_ID?: string;
  /** Drafts older than this many days are auto-discarded by the daily prune. Default 7. */
  NEWS_DRAFT_TTL_DAYS?: string;
  /** 'true' = capture message_reaction[_count] updates into digest_post_stats. Default off. */
  ENABLE_POST_ANALYTICS?: string;
  /**
   * Optional emoji→sentiment overrides for the analytics panel:
   * comma-separated `emoji:pos|neg|neutral` pairs merged over the built-in
   * map (👍❤️🔥🎉👏 = pos, 👎 = neg). All reactions are captured regardless;
   * this only classifies them at presentation (plan §23.2).
   */
  NEWS_REACTION_SIGNALS?: string;
  /** Optional sponsor footer line appended after sanitization (never LLM-generated). */
  NEWS_SPONSOR_TEXT?: string;
  /**
   * Intraday schedule: CSV of `hour:tag` slots that drive the hourly gate,
   * e.g. "9:headlines,14:papers,20:trending". Hours are local (TIMEZONE). Each
   * slot pins its own engines + LLM mode + token budget and tags its slot key so
   * same-day slots don't collide. This is the SINGLE source for digest timing:
   * when unset (with ENABLE_NEWS_DIGEST=true) the digest does not run and the
   * gate logs a daily warning. Weekly/monthly rollups fire at the earliest
   * scheduled hour.
   */
  NEWS_SCHEDULE?: string;
  /**
   * Dev-only toggle (gitignored): 'true' enables POST /api/digest/dev/seed,
   * which inserts a fake draft to exercise the review/edit/publish/discard
   * workflow without running the pipeline. Always absent in production.
   */
  NEWS_DEV_SEED?: string;
  /** Tavily Search API key (secret) — enables the `tavily` news engine. */
  TAVILY_API_KEY?: string;
  /** Exa API key (secret) — enables the `exa` news engine. */
  EXA_API_KEY?: string;
  /**
   * Jina key (secret) — two roles: Reader extraction fallback (`r.jina.ai`,
   * 500 RPM keyed vs 20 anonymous, JSON mode via Accept: application/json) and
   * the `jsearch` engine (`s.jina.ai`, 100 RPM). Costs ~10,000 fixed tokens per
   * search request against the shared free token pool.
   */
  JINA_API_KEY?: string;
  /** LlamaParse key (secret) — documents/PDF extraction specialist (10K credits free). */
  LLAMAINDEX_APIKEY?: string;
  /** Semantic Scholar API key (secret) — lifts anonymous rate limits. Unset = keyless (throttled). */
  S2_API_KEY?: string;
  /** Max candidates enriched with full-text per run. Default 4 (cost guard). */
  NEWS_EXTRACT_MAX_PER_RUN?: string;

  /** Digest LLM endpoint override. Unset = OPENAI_BASE_URL. */
  DIGEST_BASE_URL?: string;
  /** Digest LLM key override. Unset = OPENAI_API_KEY. */
  DIGEST_API_KEY?: string;
  /** Digest model id. Unset = TEXT_MODEL, then MODEL_NAME. */
  DIGEST_MODEL?: string;
  /** Digest LLM timeout ms. Default 120000. */
  DIGEST_TIMEOUT_MS?: string;
  /** Provider params merged into the digest request body (e.g. thinking-off). Unset = clean payload (deliberately NOT inherited from LLM_EXTRA_BODY_JSON — provider payloads are not portable across providers). */
  DIGEST_EXTRA_BODY_JSON?: string;
  /** 'json' = send response_format json_object for the digest. Default json. */
  DIGEST_RESPONSE_FORMAT?: string;
}

/** Telegram Update object (subset relevant to this bot). */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;

  /** Anonymous reaction aggregate (channels default) — analytics input. */
  message_reaction_count?: {
    chat: { id: number };
    message_id: number;
    reactions?: {
      total_count?: number;
      type?: { type?: string; emoji?: string };
    }[];
  };
  /** Named (non-anonymous) reaction delta — per-user signal. */
  message_reaction?: {
    chat: { id: number };
    message_id: number;
  };
}

/** Telegram Message object (subset). */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  /** Present on forwards (incl. the discussion-group copy of a channel post). */
  forward_from_chat?: { id: number };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  video?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video_note?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  animation?: { file_id: string; file_name?: string; mime_type?: string };
  /** Set for messages that are direct service-command like new members etc. */
  new_chat_members?: unknown[];
  left_chat_member?: unknown;
}

/** Telegram ChatMember status values relevant for admin detection. */
export const ADMIN_STATUSES = ['creator', 'administrator'] as const;

/** Telegram PhotoSize object. */
export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
