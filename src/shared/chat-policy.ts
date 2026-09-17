/**
 * Shared chat policy: the front gate every message-consuming feature applies
 * before any feature logic. Two rules, both fail-closed-safe and observable:
 *
 *   1. Group chats only — private chats/DMs and channels never enter message
 *      pipelines (the bot's admin DMs are not content).
 *   2. Allowed-groups whitelist (ALLOWED_GROUP_IDS) — when set, only those
 *      chats pass; unset/empty = allow all groups (backward compatible).
 *
 * Deliberately NOT here: admin exemption (a moderation concept — strangers'
 * questions in the discussion feature must still be answered for admins),
 * bot-sender skips (spam bots must stay moderatable; the discussion feature
 * skips bots for its own trigger reasons), and anything reaction-shaped
 * (analytics capture matches its own posts, not the whitelist).
 */

import { envList } from '../core/config';
import type { Env } from '../core/types';

export type ChatDenyReason = 'non_group' | 'group_not_whitelisted';

/** Group/supergroup check (channels, private chats, DMs fail). */
export function isGroupChat(chatType: string | undefined): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

/**
 * Whitelist check. Parses ALLOWED_GROUP_IDS once per call (comma/space
 * separated numerics, garbage ignored) — matches the moderation behavior
 * this was extracted from. Empty/unset = allow all.
 */
export function isAllowedGroup(env: Env, chatId: number): boolean {
  const allowed = envList(env.ALLOWED_GROUP_IDS)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  if (allowed.length === 0) return true;
  return allowed.includes(chatId);
}

/**
 * The standard front gate. Returns `{ allowed: true }` or the first failing
 * reason (group-type before whitelist — a private chat is never even
 * measured against the list). Callers keep their own logging/audit mapping.
 */
export function chatAllowed(
  env: Env,
  chatType: string | undefined,
  chatId: number,
): { allowed: boolean; reason: ChatDenyReason | null } {
  if (!isGroupChat(chatType)) return { allowed: false, reason: 'non_group' };
  if (!isAllowedGroup(env, chatId)) {
    return { allowed: false, reason: 'group_not_whitelisted' };
  }
  return { allowed: true, reason: null };
}
