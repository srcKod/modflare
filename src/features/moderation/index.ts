/**
 * Moderation feature: group-message pipeline, bot-message self-clean, and its
 * contributions to the worker shell (crons, webhook updates, admin API routes).
 *
 * Pipeline lifecycle for one update:
 *   1. Group/whitelist/activation gates (cheap checks first).
 *   2. Admin exemption, video policy, PROCESS_MODE filter.
 *   3. LLM verdict (fail-open) → delete + optional fun reply, or keep.
 */

import { envBool, envList } from '../../core/config';
import { makeLogger } from '../../core/logger';
import type { AuditLogger } from '../../core/logger';
import {
  buildUserMention,
  deleteMessage,
  deleteMessageDetailed,
  sendMessage,
} from '../../core/telegram';
import type { DeleteResult } from '../../core/telegram';
import type { Env, TelegramUpdate } from '../../core/types';
import type { FeatureManifest } from '../../core/router';
import { moderateContent, resolveModel } from './llm';
import { extractMedia, isAdminUser, isPolicyVideo } from './policy';
import { isActivePeriod, shouldProcess } from './scheduler';
import { moderationAdminRoutes } from './admin';

/** Safe generic line used when ENABLE_FUNRESPONSE is on but the model
 * returned no usable fun_response. */
const FUN_FALLBACK = 'Oops, that one got misplaced — carry on! 😄';

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
  if (!env.DB || !envBool(env.ENABLE_SELF_CLEAN, false)) return;
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
  if (!env.DB || !envBool(env.ENABLE_SELF_CLEAN, false)) return;
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

/* ------------------------------------------------------------------ */
/* Webhook pipeline                                                    */
/* ------------------------------------------------------------------ */

/**
 * Consume one message/edited_message update. Always returns true (the update
 * kind was claimed by this route); internal errors are logged, never thrown,
 * and fail open — an internal error must never cause a spurious deletion.
 */
async function handleModerationUpdate(
  env: Env,
  update: TelegramUpdate,
  logger: AuditLogger,
): Promise<boolean> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return true;

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
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return true;

  // Optional chat whitelist. When ALLOWED_GROUP_IDS is set, only moderate in
  // those specific chats (numeric IDs, negatives for supergroups). Any other
  // chat is ignored before the activation gate, admin lookup, video policy, or
  // LLM call, so a stray copy of the bot can't burn CPU/AI-token quota. Unset
  // or empty = allow all groups (backward compatible / fail-open).
  const allowedGroups = envList(env.ALLOWED_GROUP_IDS)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  if (allowedGroups.length > 0 && !allowedGroups.includes(msg.chat.id)) {
    await logger.debug('group_not_whitelisted', { ...ctx });
    return true;
  }

  // Activation gate.
  if (!isActivePeriod(env)) {
    await logger.debug('inactive_period', { ...ctx });
    return true;
  }

  // Service messages (new members, pinned, etc.) are not user content.
  if (msg.new_chat_members || msg.left_chat_member) return true;

  try {
    // Admins are exempt: responsible members selected by the owner. We take
    // no action on admins (delete or LLM) during active hours. If
    // ADMIN_USERNAMES is configured this is a local username match (no API
    // call); otherwise it falls back to getChatMember.
    if (msg.from) {
      const admin = await isAdminUser(env, msg);
      if (admin) {
        await logger.info('admin_exempt', { ...ctx });
        return true;
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
      return true;
    }

    // PROCESS_MODE filter: only analyze messages that match the configured
    // signal (media / links / both / all). Saves LLM tokens on plain text.
    // (Videos already handled above, so 'media' here = photo/GIF/document.)
    if (!shouldProcess(env, msg)) {
      await logger.debug('skipped_process_mode', {
        ...ctx,
        reason: 'process_mode_filter',
      });
      return true;
    }

    const { text, media } = await extractMedia(env, msg);

    // If we have no text and no resolvable media, nothing to analyze.
    if (!text && media.length === 0) {
      await logger.debug('skipped_empty', { ...ctx });
      return true;
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
  return true;
}

/**
 * Moderation's contribution to the worker shell. Update priority 100: late —
 * pre-empting handlers (e.g. analytics capture) register lower priorities.
 */
export const moderationFeature: FeatureManifest = {
  name: 'moderation',
  crons: [
    // Self-clean expired bot messages; must match [triggers] in wrangler.toml.
    { expr: '*/10 * * * *', handler: (env) => cleanExpiredBotMessages(env) },
  ],
  updates: [
    {
      kinds: ['message', 'edited_message'],
      priority: 100,
      handler: (env, update, logger) => handleModerationUpdate(env, update, logger),
    },
  ],
  adminRoutes: moderationAdminRoutes,
};
