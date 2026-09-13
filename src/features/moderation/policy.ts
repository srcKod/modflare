/**
 * Moderation policy: the product-hosted video policy and media extraction.
 * Pure decisions over Telegram payloads — the transport lives in
 * core/telegram.ts (which also owns admin identity checks), the pipeline
 * that acts on these decisions lives in features/moderation/index.ts.
 */

import { getFileDataUrl } from '../../core/telegram';
import type { Env, TelegramMessage } from '../../core/types';
import type { MediaPart } from './types';

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
