import { isActivePeriod, shouldProcess } from './scheduler';
import {
  buildUserMention,
  deleteMessage,
  extractMedia,
  isAdminUser,
  isPolicyVideo,
} from './telegram-api';
import { moderateContent } from './llm-client';
import { sendMessage } from './telegram-api';
import { makeLogger } from './logger';
import { handleAdmin } from './admin';
import type { Env, TelegramMessage, TelegramUpdate } from './types';

/** Safe generic line used when ENABLE_FUNRESPONSE is on but the model
 * returned no usable fun_response. */
const FUN_FALLBACK = 'Oops, that one got misplaced — carry on! 😄';

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

/**
 * Prune audit_log rows older than the configured retention (LOG_RETENTION_DAYS,
 * default 30 days). Returns the number of deleted rows, or -1 if no DB.
 */
async function pruneExpiredAudit(env: Env): Promise<number> {
  if (!env.DB) return -1;
  const days = Number(env.LOG_RETENTION_DAYS) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await env.DB.prepare(
      'DELETE FROM audit_log WHERE ts < ?',
    )
      .bind(cutoff)
      .run();
    return res.meta.changes ?? 0;
  } catch (err) {
    console.error(`audit prune failed: ${err}`);
    return 0;
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
   * Cron handler for log rotation: prunes audit_log rows older than the
   * configured retention. Wired to a Cloudflare cron trigger.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
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
    // Provider + model of the configured LLM endpoint, attached to every
    // log row so the audit panel can attribute decisions/errors to a
    // specific endpoint even after a switch.
    provider: env.OPENAI_BASE_URL ?? null,
    model: env.MODEL_NAME ?? null,
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
        await sendMessage(env, msg.chat.id, funText, undefined, funParseMode);
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
export {
  deleteMessage,
  extractMedia,
  isAdminUser,
  isPolicyVideo,
  moderateContent,
  isActivePeriod,
};
export { shouldProcess } from './scheduler';
export { getFileDataUrl } from './telegram-api';