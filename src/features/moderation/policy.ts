/**
 * Moderation policy helpers: admin detection/exemption, the product-hosted
 * video policy, and media extraction. Pure decisions over Telegram payloads —
 * the transport lives in core/telegram.ts, the pipeline that acts on these
 * decisions lives in features/moderation/index.ts.
 */

import { envList } from '../../core/config';
import { callTelegram, getFileDataUrl } from '../../core/telegram';
import { ADMIN_STATUSES } from '../../core/types';
import type { Env, TelegramMessage } from '../../core/types';
import type { MediaPart } from './types';

/** Check whether a member is an admin / group creator via the API. */
export async function isAdmin(
  env: Env,
  chatId: number,
  userId: number,
): Promise<boolean> {
  const json = await callTelegram(env, 'getChatMember', {
    chat_id: chatId,
    user_id: userId,
  });
  const status = (json.result as { status?: string } | undefined)?.status;
  return ADMIN_STATUSES.includes(status as (typeof ADMIN_STATUSES)[number]);
}

/**
 * Parse ADMIN_USERNAMES into a set of lowercased usernames (optional leading
 * '@', comma/space separators).
 */
function configuredAdminSet(env: Env): Set<string> | null {
  const list = envList(env.ADMIN_USERNAMES);
  if (!list.length) return null;
  return new Set(list.map((name) => name.replace(/^@/, '').toLowerCase()));
}

/**
 * Decide whether a message sender is exempt as an admin.
 *
 * When ADMIN_USERNAMES is configured, the decision is made locally from the
 * sender's username (no network call). Otherwise it falls back to the
 * getChatMember API lookup.
 */
export async function isAdminUser(
  env: Env,
  msg: Pick<TelegramMessage, 'from' | 'chat'>,
): Promise<boolean> {
  if (!msg.from) return false;

  const configured = configuredAdminSet(env);
  const idList = envList(env.ADMIN_USER_IDS);
  if (!configured && !idList.length) {
    // Neither username list nor ID list configured -> fall back to the API.
    return isAdmin(env, msg.chat.id, msg.from.id);
  }

  // Local matching: username in ADMIN_USERNAMES, or id in ADMIN_USER_IDS.
  const username = msg.from.username?.toLowerCase();
  if (configured && username && configured.has(username)) return true;
  if (idList.length) {
    const id = Number(msg.from.id);
    if (Number.isInteger(id) && id > 0 && idList.includes(String(id))) return true;
  }
  return false;
}

/**
 * True when a message carries a product-hosted video that must be deleted
 * by policy (not analyzed): a `video`, a `video_note`, or a document whose
 * mime type is video/*. GIFs (`animation`) are deliberately excluded here.
 */
export function isPolicyVideo(msg: TelegramMessage): boolean {
  if (msg.video || msg.video_note) return true;
  if (msg.document?.mime_type?.startsWith('video/')) return true;
  return false;
}

/**
 * Extract moderable content from a Telegram message into text + media parts.
 * Picks the largest photo in a photo set. Returns media parts whose download
 * URLs could be resolved.
 */
export async function extractMedia(
  env: Env,
  msg: TelegramMessage,
): Promise<{ text: string; media: MediaPart[] }> {
  const text = [msg.text, msg.caption].filter(Boolean).join('\n').trim();

  const media: MediaPart[] = [];

  if (msg.photo && msg.photo.length > 0) {
    // Largest photo is the last element.
    const largest = msg.photo[msg.photo.length - 1];
    const dataUrl = await getFileDataUrl(env, largest.file_id);
    if (dataUrl) media.push({ kind: 'photo', file_id: largest.file_id, dataUrl });
  }

  // NOTE: product-hosted videos are handled by the delete-video policy in
  // the pipeline and never reach the LLM, so we do not emit a 'video' media
  // part here. Only photos and GIFs (animations) are sent to the model.

  if (msg.animation) {
    const dataUrl = await getFileDataUrl(env, msg.animation.file_id, msg.animation.mime_type);
    if (dataUrl)
      media.push({
        kind: 'animation',
        file_id: msg.animation.file_id,
        dataUrl,
        mimeType: msg.animation.mime_type,
      });
  }

  // Only send documents that look like images to the LLM (as image_url).
  // Video-mimetype documents are caught by the delete-video policy and never
  // reach the LLM; other non-image documents (pdf, zip, …) are left for the
  // text-based moderation of the caption/name rather than sent as media.
  if (msg.document && msg.document.mime_type?.startsWith('image/')) {
    const dataUrl = await getFileDataUrl(env, msg.document.file_id, msg.document.mime_type);
    if (dataUrl)
      media.push({
        kind: 'document',
        file_id: msg.document.file_id,
        dataUrl,
        mimeType: msg.document.mime_type,
      });
  }

  return { text, media };
}
