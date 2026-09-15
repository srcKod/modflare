/**
 * Moderation feature: group-message pipeline and its contributions to the
 * worker shell (crons, webhook updates, admin API routes). Bot-message
 * self-clean lives in shared/selfclean.ts (registered via the cron route).
 *
 * Pipeline lifecycle for one update:
 *   1. Group/whitelist/activation gates (cheap checks first).
 *   2. Admin exemption, video policy, PROCESS_MODE filter.
 *   3. LLM verdict (fail-open) → delete + optional fun reply, or keep.
 */

import { envList, envBool } from '../../core/config';
import { makeLogger } from '../../core/logger';
import type { AuditLogger } from '../../core/logger';
import { loadSettingOverrides, resolveSetting, settingBool } from '../../core/settings';
import {
  buildUserMention,
  deleteMessage,
  isAdminUser,
  sendMessage,
} from '../../core/telegram';
import type { Env, TelegramUpdate } from '../../core/types';
import type { FeatureManifest } from '../../core/router';
import { moderateContent, resolveModel } from './llm';
import { extractMedia, isPolicyVideo } from './policy';
import { isActivePeriod, shouldProcess } from './scheduler';
import { cleanExpiredBotMessages, trackBotMessage } from '../../shared/selfclean';
import { moderationAdminRoutes } from './admin';

/** Safe generic line used when ENABLE_FUNRESPONSE is on but the model
 * returned no usable fun_response. */
const FUN_FALLBACK = 'Oops, that one got misplaced — carry on! 😄';

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

  // Master switch (runtime settings → ENABLE_MODERATION env → default on).
  // Off means messages pass through untouched; the skip is logged so the
  // audit trail shows moderation was deliberately off, not broken. Checked
  // AFTER the group gate so private/DM noise doesn't burn a settings read.
  const overrides = await loadSettingOverrides(env.DB);
  const moderationOn =
    settingBool(
      resolveSetting(env, overrides, 'moderation_enabled'),
      true,
    ) &&
    envBool(env.ENABLE_MODERATION, true);
  if (!moderationOn) {
    await logger.debug('moderation_disabled', { ...ctx });
    return true;
  }

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
          await trackBotMessage(
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
    // Self-clean expired bot messages (capability in shared/selfclean);
    // must match [triggers] in wrangler.toml.
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
