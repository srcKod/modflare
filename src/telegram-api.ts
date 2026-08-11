import { ADMIN_STATUSES } from './types';
import type { Env, MediaPart, TelegramMessage } from './types';

const TELEGRAM_API = 'https://api.telegram.org';

/** Central helper for authenticated Telegram Bot API calls. */
async function callTelegram(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const url = `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };
  return json;
}

/** Resolve a Telegram file_id to its file_path (null if unresolvable). */
async function getFilePath(
  env: Env,
  fileId: string,
): Promise<string | null> {
  const json = await callTelegram(env, 'getFile', { file_id: fileId });
  const path = (json.result as { file_path?: string } | undefined)?.file_path;
  if (!json.ok || !path) return null;
  return path;
}

/** Guess a MIME type from a file path suffix (defaults to JPEG). */
function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    case 'jpeg':
    case 'jpg':
    default:
      return 'image/jpeg';
  }
}

/**
 * Download a Telegram file and return it as a base64 data URL, so the LLM
 * sees the image bytes without ever receiving a public URL (which would
 * (a) leak the bot token to the provider and (b) be rejected by Workers AI's
 * multimodal URL-domain allowlist, which is empty by default).
 * Returns null when the file cannot be downloaded or is too large.
 */
export async function getFileDataUrl(
  env: Env,
  fileId: string,
  mimeHint?: string,
): Promise<string | null> {
  const path = await getFilePath(env, fileId);
  if (!path) return null;

  const url = `${TELEGRAM_API}/file/bot${env.BOT_TOKEN}/${path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  // Telegram photos are small (tens of KB), but guard against pathological
  // uploads blowing up the LLM request body.
  const MAX_BYTES = 5 * 1024 * 1024;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

  const mime =
    mimeHint && mimeHint.startsWith('image/') ? mimeHint : mimeFromPath(path);

  // Workers has no Buffer; chunked String.fromCharCode avoids stack overflow
  // on larger images.
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Delete a message from a chat. Returns true on success. */
export async function deleteMessage(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  const json = await callTelegram(env, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  return json.ok === true;
}

/**
 * Send a text message to a chat. Returns true on success.
 * replyTo is optional; when set the message is shown as a reply to that id.
 * parseMode is optional ('HTML' or 'Markdown'); pass it when the text
 * contains a mention built by buildUserMention.
 */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyTo?: number,
  parseMode?: 'HTML' | 'Markdown',
): Promise<boolean> {
  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (replyTo !== undefined) params.reply_to_message_id = replyTo;
  if (parseMode) params.parse_mode = parseMode;
  const json = await callTelegram(env, 'sendMessage', params);
  if (!json.ok) {
    console.error(
      `sendMessage failed for chat ${chatId}: ` +
        (json.description || `HTTP result ok=${json.ok}`),
    );
  }
  return json.ok === true;
}

/** Escape text for use inside Telegram HTML parse mode (the text of a tag). */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build a Telegram mention string for a sender, to prepend to a reply.
 *
 * Prefers the @username when one exists. When the user has no username, falls
 * back to a clickable name link (tg://user?id=<id>) that Telegram renders as
 * the first name — this works even for users without a public @handle.
 *
 * Returns null when there is no user info at all.
 */
export function buildUserMention(from: {
  id?: number;
  first_name?: string;
  username?: string;
} | undefined): string | null {
  if (!from) return null;
  if (from.username && from.username.trim()) {
    return '@' + from.username.trim();
  }
  if (from.id && from.first_name) {
    return `<a href="tg://user?id=${from.id}">${htmlEscape(from.first_name)}</a>`;
  }
  if (from.first_name) return from.first_name;
  return null;
}

/**
 * Check whether a member is an admin / group creator.
 * Returns true only when Telegram confirms a privileged status.
 */
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
 * Parse the ADMIN_USERNAMES env var into a set of lowercased usernames,
 * accepting optional leading '@' and comma/space separators.
 */
function configuredAdminSet(env: Env): Set<string> | null {
  const raw = env.ADMIN_USERNAMES?.trim();
  if (!raw) return null;
  const set = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const name = part.replace(/^@/, '').toLowerCase();
    if (name) set.add(name);
  }
  return set;
}

/**
 * Parse the ADMIN_USER_IDS env var into a set of numeric user IDs.
 */
function parseIdSet(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const set = new Set<number>();
  for (const part of raw.split(/[,\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return set.size ? set : null;
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
  if (configured === null && !env.ADMIN_USER_IDS?.trim()) {
    // Neither username list nor ID list configured -> fall back to the API.
    return isAdmin(env, msg.chat.id, msg.from.id);
  }

  // Local matching: username in ADMIN_USERNAMES, or id in ADMIN_USER_IDS.
  if (configured) {
    const username = msg.from.username?.toLowerCase();
    if (username && configured.has(username)) return true;
  }
  const idSet = parseIdSet(env.ADMIN_USER_IDS);
  if (idSet) {
    const id = msg.from.id;
    if (id && idSet.has(id)) return true;
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
 * Extract modelliable content from a Telegram message into text + media parts.
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
  // index.ts and never reach the LLM, so we do not emit a 'video' media part
  // here. Only photos and GIFs (animations) are sent to the model as images.

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