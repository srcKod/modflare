import { isActivePeriod, shouldProcess } from './scheduler';
import { buildUserMention, deleteMessage } from './core/telegram';
import { extractMedia, isAdminUser, isPolicyVideo } from './features/moderation/policy';
import { moderateContent, resolveModel } from './llm-client';
import { deleteMessageDetailed, sendMessage } from './core/telegram';
import type { DeleteResult } from './core/telegram';
import { makeLogger, pruneExpiredAudit } from './core/logger';
import { handleAdmin } from './admin';
import type { Env, TelegramMessage, TelegramUpdate } from './core/types';

/** Safe generic line used when ENABLE_FUNRESPONSE is on but the model
 * returned no usable fun_response. */
const FUN_FALLBACK = 'Oops, that one got misplaced — carry on! 😄';

/**
 * Cron expression for the bot-message self-clean trigger. MUST match the
 * corresponding entry in [triggers].crons in wrangler.toml.
 */
const CRON_BOT_CLEANUP = '*/10 * * * *';

// 1x1 transparent PNG (67 bytes) used as the /favicon.ico response so
// browser tab requests don't surface 405 errors in the dev console.
const FAVICON_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Return the 1x1 transparent PNG as the favicon response. */
function faviconResponse(): Response {
  return new Response(FAVICON_PNG, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/* ------------------------------------------------------------------ */
/* Bot message self-clean                                              */
/* ------------------------------------------------------------------ */

/** Max bot_messages rows processed per cron tick (bounds API calls). */
const CLEANUP_BATCH_SIZE = 25;
/** Drop a tracking row after this many failed delete attempts. */
const CLEANUP_MAX_ATTEMPTS = 5;
/** Telegram refuses to delete messages older than ~48 hours. */
const TELEGRAM_DELETE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Shape of a row tracked for self-clean. */
type BotMessageRow = {
  id: number;
  message_id: number;
  chat_id: number;
  chat_username: string | null;
  message: string | null;
  kind: string;
  sent_at: string;
  attempts: number;
};

/** Whether bot-message self-clean is on (ENABLE_SELF_CLEAN='true'). */
function selfCleanEnabled(env: Env): boolean {
  return (env.ENABLE_SELF_CLEAN || '').trim().toLowerCase() === 'true';
}

/**
 * Track an outgoing bot message for later self-clean. No-op unless
 * ENABLE_SELF_CLEAN is on and D1 is bound. Never throws: tracking failure
 * must not break the moderation pipeline.
 */
async function recordBotMessage(
  env: Env,
  chatId: number,
  messageId: number,
  kind: string,
  chatUsername: string | null,
  message: string | null,
): Promise<void> {
  if (!env.DB || !selfCleanEnabled(env)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO bot_messages
         (message_id, chat_id, chat_username, message, kind, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        messageId,
        chatId,
        chatUsername,
        message ? message.slice(0, 500) : null,
        kind,
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    console.error(`recordBotMessage failed: ${err}`);
  }
}

async function dropBotMessageRow(env: Env, id: number): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare('DELETE FROM bot_messages WHERE id = ?').bind(id).run();
  } catch (err) {
    console.error(`dropBotMessageRow failed: ${err}`);
  }
}

/**
 * Cron job: delete tracked bot messages whose TTL expired. Rows are dropped
 * when the delete succeeds, when Telegram says the message is already gone,
 * when the message outlived Telegram's ~48h delete window, or after
 * CLEANUP_MAX_ATTEMPTS failed attempts (logged for debugging).
 */
async function cleanExpiredBotMessages(env: Env): Promise<void> {
  if (!env.DB || !selfCleanEnabled(env)) return;
  const logger = makeLogger(env);
  const ttlMinutes = Number(env.SELF_CLEAN_TTL_MINUTES) || 60;
  const now = Date.now();
  const cutoff = new Date(now - ttlMinutes * 60_000).toISOString();

  let rows: BotMessageRow[];
  try {
    const res = await env.DB.prepare(
      `SELECT id, message_id, chat_id, chat_username, message, kind, sent_at, attempts
       FROM bot_messages WHERE sent_at <= ? ORDER BY sent_at LIMIT ?`,
    )
      .bind(cutoff, CLEANUP_BATCH_SIZE)
      .all<BotMessageRow>();
    rows = res.results;
  } catch (err) {
    console.error(`bot-message cleanup query failed: ${err}`);
    return;
  }

  for (const row of rows) {
    // Older than Telegram's delete window: it can never be deleted.
    if (now - Date.parse(row.sent_at) > TELEGRAM_DELETE_MAX_AGE_MS) {
      await dropBotMessageRow(env, row.id);
      await logger.debug('bot_message_cleanup_expired', {
        chat_id: row.chat_id,
        chat_username: row.chat_username,
        extra: { messageId: row.message_id, kind: row.kind },
      });
      continue;
    }

    let del: DeleteResult;
    try {
      del = await deleteMessageDetailed(env, row.chat_id, row.message_id);
    } catch (err) {
      del = { ok: false, notFound: false, description: String(err) };
    }

    if (del.ok || del.notFound) {
      await dropBotMessageRow(env, row.id);
      await logger.info('bot_message_deleted', {
        chat_id: row.chat_id,
        chat_username: row.chat_username,
        extra: {
          messageId: row.message_id,
          kind: row.kind,
          alreadyGone: del.notFound,
        },
      });
      continue;
    }

    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= CLEANUP_MAX_ATTEMPTS) {
      await dropBotMessageRow(env, row.id);
      await logger.debug('bot_message_cleanup_failed', {
        chat_id: row.chat_id,
        chat_username: row.chat_username,
        extra: {
          messageId: row.message_id,
          kind: row.kind,
          attempts,
          lastError: del.description ?? null,
        },
      });
    } else {
      try {
        await env.DB.prepare(
          'UPDATE bot_messages SET attempts = ? WHERE id = ?',
        )
          .bind(attempts, row.id)
          .run();
      } catch (err) {
        console.error(`bot-message cleanup attempt update failed: ${err}`);
      }
    }
  }
}

/**
 * Telegram moderation bot entry point.
 *
 * Lifecycle for a single update:
 *   1. Validate request origin (optional secret token).
 *   2. Gate on active period (night hours). Outside it -> 200 OK, no LLM.
 *   3. Extract text + media from the message.
 *   4. Ask the OpenAI-compatible LLM whether to flag it.
 *   5. If flagged, delete the message.
 *
 * We always answer 200 OK to Telegram so the webhook is not spammed with
 * retries, even when something fails internally.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Admin panel routes (login, filtered audit log view, CSV export).
    // Only active when ADMIN_PANEL_TOKEN is set; otherwise handleAdmin
    // returns null and we fall through to the webhook handler.
    const adminRes = await handleAdmin(request, env);
    if (adminRes) return adminRes;

    // Browsers auto-request /favicon.ico on every page load; return a tiny
    // 1x1 transparent PNG so the dev console isn't spammed with 405s.
    if (url.pathname === '/favicon.ico') {
      return faviconResponse();
    }

    // Only accept POST webhook deliveries.
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Optional origin validation.
    if (env.WEBHOOK_SECRET_TOKEN) {
      const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (provided !== env.WEBHOOK_SECRET_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Fire-and-forget the moderation pipeline so we can return 200 immediately.
    // The work continues in the background via waitUntil.
    void _ctx.waitUntil(handleUpdate(env, update));

    return new Response('OK', { status: 200 });
  },

  /**
   * Cron handler. Two triggers (see [triggers] in wrangler.toml):
   *   - every 10 min: self-clean expired bot messages (ENABLE_SELF_CLEAN)
   *   - daily 04:00 UTC: prune expired audit_log rows (LOG_RETENTION_DAYS)
   * Unknown cron expressions fall back to the audit prune (safe default).
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === CRON_BOT_CLEANUP) {
      await cleanExpiredBotMessages(env);
      return;
    }
    const removed = await pruneExpiredAudit(env);
    const logger = makeLogger(env);
    logger.info('audit_prune', {
      removed: removed < 0 ? null : removed,
      retentionDays: env.LOG_RETENTION_DAYS || '30',
    });
  },
};

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const logger = makeLogger(env);
  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  const ctx = {
    // Provider of the configured LLM endpoint, attached to every log row so
    // the audit panel can attribute decisions/errors to a specific endpoint
    // even after a switch.
    provider: env.OPENAI_BASE_URL ?? null,
    // Model stays null until the routing decision is known (text ->
    // TEXT_MODEL, media -> MODEL_NAME) and is set just before the LLM call
    // below, so rows never attribute an event to a model that didn't
    // handle it (pre-LLM skips/errors log null).
    model: null as string | null,
    chat_id: msg.chat.id,
    chat_username: msg.chat.username ?? null,
    chat_title: msg.chat.title ?? null,
    user_id: msg.from?.id ?? null,
    username: msg.from?.username ?? null,
    full_name: msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').trim() || null
      : null,
    message_id: msg.message_id,
  };

  // Only moderate in groups (and supergroups). Ignore private chats/admin DMs.
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;

  // Optional chat whitelist. When ALLOWED_GROUP_IDS is set, only moderate in
  // those specific chats (numeric IDs, negatives for supergroups). Any other
  // chat is ignored before the activation gate, admin lookup, video policy, or
  // LLM call, so a stray copy of the bot can't burn CPU/AI-token quota. Unset
  // or empty = allow all groups (backward compatible / fail-open).
  const allowedGroups = (env.ALLOWED_GROUP_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  if (allowedGroups.length > 0 && !allowedGroups.includes(msg.chat.id)) {
    await logger.debug('group_not_whitelisted', { ...ctx });
    return;
  }

  // Activation gate.
  if (!isActivePeriod(env)) {
    await logger.debug('inactive_period', { ...ctx });
    return;
  }

  // Service messages (new members, pinned, etc.) are not user content.
  if (msg.new_chat_members || msg.left_chat_member) return;

  try {
    // Admins are exempt: responsible members selected by the owner. We take
    // no action on admins (delete or LLM) during active hours. If
    // ADMIN_USERNAMES is configured this is a local username match (no API
    // call); otherwise it falls back to getChatMember.
    if (msg.from) {
      const admin = await isAdminUser(env, msg);
      if (admin) {
        await logger.info('admin_exempt', { ...ctx });
        return;
      }
    }

    // Video policy (non-admins, active hours): any product-hosted video is
    // deleted immediately — no LLM. GIFs are not affected (they stay on the
    // image path). This avoids wasted LLM calls and unmoderated video.
    if (isPolicyVideo(msg)) {
      const deleted = await deleteMessage(env, msg.chat.id, msg.message_id);
      await logger.info('video_deleted', {
        ...ctx,
        decision: 'delete',
        reason: 'policy_video',
        deleted,
      });
      return;
    }

    // PROCESS_MODE filter: only analyze messages that match the configured
    // signal (media / links / both / all). Saves LLM tokens on plain text.
    // (Videos already handled above, so 'media' here = photo/GIF/document.)
    if (!shouldProcess(env, msg)) {
      await logger.debug('skipped_process_mode', {
        ...ctx,
        reason: 'process_mode_filter',
      });
      return;
    }

    const { text, media } = await extractMedia(env, msg);

    // If we have no text and no resolvable media, nothing to analyze.
    if (!text && media.length === 0) {
      await logger.debug('skipped_empty', { ...ctx });
      return;
    }

    // Same helper as moderateContent: record the model that will actually
    // process this message (TEXT_MODEL for text, MODEL_NAME for media).
    ctx.model = resolveModel(env, media.length > 0);

    await logger.debug('moderating', {
      ...ctx,
      textLen: text.length,
      mediaCount: media.length,
    });

    const result = await moderateContent(env, text, media);

    if (result.flag) {
      // Send the fun reply FIRST, anchored to the still-existing message,
      // so the reply preview has a valid target. Only attempt the reply
      // when the model actually produced a fun line (no point wasting a
      // Telegram call on the generic fallback when there's nothing fun to
      // post). If the model returned one, build mention + text now so we
      // can post + delete in the right order.
      let funLine: string | null = null;
      let funText: string | null = null;
      let funParseMode: 'HTML' | undefined;
      if (result.funResponse) {
        funLine = result.funResponse || FUN_FALLBACK;
        const mention = buildUserMention(msg.from);
        funText = mention ? `${mention}, ${funLine}` : funLine;
        funParseMode = mention?.startsWith('<a href') ? 'HTML' : undefined;
      }

      const deleted = await deleteMessage(env, msg.chat.id, msg.message_id);
      await logger.warn('flagged_deleted', {
        ...ctx,
        decision: 'delete',
        reason: result.reason,
        deleted,
        message_text: text,
        llm_response: result.llmResponse ?? result.reason,
        extra: { deleted },
      });

      // Post the fun reply AFTER the delete so the original spam is already
      // gone and the bot's reply stands alone with the user mention as its
      // only context anchor. No reply_to_message_id: the target was just
      // removed by the delete call, so passing msg.message_id here would
      // produce a "message to be replied not found" 400 from Telegram.
      if (deleted && funText) {
        const sentId = await sendMessage(
          env,
          msg.chat.id,
          funText,
          undefined,
          funParseMode,
        );
        // Track the reply for self-clean (no-op unless ENABLE_SELF_CLEAN).
        if (sentId !== null) {
          await recordBotMessage(
            env,
            msg.chat.id,
            sentId,
            'fun',
            msg.chat.username ?? null,
            funText,
          );
        }
      }
    } else {
      await logger.info('safe', {
        ...ctx,
        decision: 'keep',
        reason: result.reason,
        message_text: text,
        llm_response: result.llmResponse ?? result.reason,
      });
    }
  } catch (err) {
    // Fail-open: never let an internal error cause a spurious deletion.
    await logger.error('moderation_error', {
      ...ctx,
      reason: String(err),
    });
  }
}

// Re-export for potential use by scripts/tests.
export { isActivePeriod } from './scheduler';
export { moderateContent, resolveModel } from './llm-client';
export { deleteMessage } from './core/telegram';
export { shouldProcess } from './scheduler';
export { getFileDataUrl } from './core/telegram';