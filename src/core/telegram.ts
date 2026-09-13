/**
 * Core Telegram Bot API client — pure transport, zero policy.
 *
 * Every module talks to Telegram through these helpers; nothing here knows
 * about any feature calling it. Errors are returned to the
 * caller (never thrown) so a Telegram hiccup can never break a pipeline.
 */

import type { Env } from './types';

const TELEGRAM_API = 'https://api.telegram.org';

/** Central helper for authenticated Telegram Bot API calls. */
export async function callTelegram(
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
async function getFilePath(env: Env, fileId: string): Promise<string | null> {
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
 * Download a Telegram file and return it as a base64 data URL, so LLM callers
 * see the bytes without a public URL (avoids leaking the bot token to the
 * provider and satisfies Workers AI's URL-domain allowlist).
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

  // Guard against pathological uploads blowing up the LLM request body.
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

/** deleteMessage result with enough detail to distinguish retryable states. */
export interface DeleteResult {
  ok: boolean;
  /** Telegram says the message no longer exists (treat as deleted). */
  notFound: boolean;
  description?: string;
}

/**
 * deleteMessage variant that distinguishes "already gone" (drop tracking)
 * from a transient failure (retry later).
 */
export async function deleteMessageDetailed(
  env: Env,
  chatId: number,
  messageId: number,
): Promise<DeleteResult> {
  const json = await callTelegram(env, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  return {
    ok: json.ok === true,
    notFound:
      json.ok !== true &&
      /message to delete not found/i.test(json.description ?? ''),
    description: json.description,
  };
}

/**
 * Send a text message to a chat. Returns the new message_id on success
 * (needed to track the message later) or null on failure.
 * replyTo is optional; parseMode ('HTML' | 'Markdown') when the text carries markup.
 */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyTo?: number,
  parseMode?: 'HTML' | 'Markdown',
): Promise<number | null> {
  const params: Record<string, unknown> = { chat_id: chatId, text };
  if (replyTo !== undefined) params.reply_to_message_id = replyTo;
  if (parseMode) params.parse_mode = parseMode;
  const json = await callTelegram(env, 'sendMessage', params);
  if (!json.ok) {
    console.error(
      `sendMessage failed for chat ${chatId}: ` +
        (json.description || `HTTP result ok=${json.ok}`),
    );
    return null;
  }
  const id = (json.result as { message_id?: unknown } | undefined)
    ?.message_id;
  return typeof id === 'number' ? id : null;
}

/** Escape text for use inside Telegram HTML parse mode (the text of a tag). */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build a Telegram mention string for a sender.
 *
 * Prefers the @username; without one, falls back to a clickable name link
 * (tg://user?id=<id>) that renders as the first name — works even for users
 * without a public @handle. Returns null when there is no user info at all.
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
