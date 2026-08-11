/**
 * Type definitions for the Telegram moderation bot.
 *
 * All LLM endpoint choices are configuration, not code: the Worker reads
 * OPENAI_BASE_URL / OPENAI_API_KEY / MODEL_NAME from the environment, so it
 * works unchanged against OpenAI, OpenRouter, Groq, Cloudflare Workers AI
 * (via AI Gateway), or any local OpenAI-compatible server.
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
   * Optional comma-separated admin usernames (with or without leading @).
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
  /** Optional LLM request timeout in ms. Defaults to 60000. */
  LLM_TIMEOUT_MS?: string;
  /** Optional cap on LLM output tokens. Bounds reasoning-heavy models. */
  LLM_MAX_TOKENS?: string;
  /** Optional structured output: set `json` to send response_format json_object (model-dependent). */
  LLM_RESPONSE_FORMAT?: string;
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
}

/** Telegram Update object (subset relevant to this bot). */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/** Telegram Message object (subset). */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
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

/** Result of the LLM moderation call. */
export interface ModerationResult {
  flag: boolean;
  reason: string;
  /**
   * Optional kind/harmless funny reply generated by the SAME moderation
   * completion when the funny-response feature is enabled. Present only when
   * flag is true and the feature is on. Falls back to a generic safe line.
   */
  funResponse?: string;
  /**
   * The raw text returned by the LLM (for audit logging). May be empty when
   * the result was synthesized from an error/fallback.
   */
  llmResponse?: string;
}

/**
 * Shape of the parsed LLM JSON response. `fun_response` is optional and is
 * only requested when the funny-response feature is enabled.
 */
export interface JsonModerationReply {
  flag?: unknown;
  reason?: unknown;
  /** Optional funny reply, requested only when ENABLE_FUNRESPONSE is on. */
  fun_response?: unknown;
}

/** Which pieces of a message we resolved and are sending the LLM. */
export interface MediaPart {
  kind: 'photo' | 'video' | 'document' | 'animation';
  file_id: string;
  url: string;
  mimeType?: string;
}
