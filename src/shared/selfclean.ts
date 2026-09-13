/**
 * Bot-message self-clean: track messages the bot posts and delete them after
 * a TTL. Capability, not policy — any feature that posts auto-expiring
 * content tracks via trackBotMessage and registers cleanExpiredBotMessages
 * on a cron (rows carry a generic `kind` for attribution).
 *
 * Rows are dropped when the delete succeeds, when Telegram says the message
 * is already gone, when the message outlives Telegram's ~48h delete window,
 * or after CLEANUP_MAX_ATTEMPTS failed attempts.
 */

import { envBool } from '../core/config';
import { makeLogger } from '../core/logger';
import { deleteMessageDetailed } from '../core/telegram';
import type { DeleteResult } from '../core/telegram';
import type { Env } from '../core/types';

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
 * must not break the caller's pipeline.
 */
export async function trackBotMessage(
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
      'INSERT INTO bot_messages (message_id, chat_id, chat_username, message, kind, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
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
    console.error('trackBotMessage failed: ' + String(err));
  }
}

async function dropBotMessageRow(env: Env, id: number): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare('DELETE FROM bot_messages WHERE id = ?').bind(id).run();
  } catch (err) {
    console.error('dropBotMessageRow failed: ' + String(err));
  }
}

/** Cron job: delete tracked bot messages whose TTL expired. */
export async function cleanExpiredBotMessages(env: Env): Promise<void> {
  if (!env.DB || !envBool(env.ENABLE_SELF_CLEAN, false)) return;
  const logger = makeLogger(env);
  const ttlMinutes = Number(env.SELF_CLEAN_TTL_MINUTES) || 60;
  const now = Date.now();
  const cutoff = new Date(now - ttlMinutes * 60_000).toISOString();

  let rows: BotMessageRow[];
  try {
    const res = await env.DB.prepare(
      'SELECT id, message_id, chat_id, chat_username, message, kind, sent_at, attempts FROM bot_messages WHERE sent_at <= ? ORDER BY sent_at LIMIT ?',
    )
      .bind(cutoff, CLEANUP_BATCH_SIZE)
      .all<BotMessageRow>();
    rows = res.results;
  } catch (err) {
    console.error('bot-message cleanup query failed: ' + String(err));
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
        await env.DB.prepare('UPDATE bot_messages SET attempts = ? WHERE id = ?')
          .bind(attempts, row.id)
          .run();
      } catch (err) {
        console.error('bot-message cleanup attempt update failed: ' + String(err));
      }
    }
  }
}
