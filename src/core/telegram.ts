/**
 * Core Telegram Bot API client — pure transport, zero policy.
 *
 * Every module talks to Telegram through these helpers; nothing here knows
 * about any feature that calls it. Errors are returned to the
 * caller (never thrown) so a Telegram hiccup can never break a pipeline.
 */

import { envList } from './config';
import { ADMIN_STATUSES } from './types';
import type { Env, TelegramMessage } from './types';

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

/* ------------------------------------------------------------------ */
/* Admin identity (bot-wide config: ADMIN_USERNAMES / ADMIN_USER_IDS)   */
/* ------------------------------------------------------------------ */

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

/** Parse ADMIN_USERNAMES into a set of lowercased usernames (optional '@'). */
function configuredAdminSet(env: Env): Set<string> | null {
  const list = envList(env.ADMIN_USERNAMES);
  if (!list.length) return null;
  return new Set(list.map((name) => name.replace(/^@/, '').toLowerCase()));
}

/**
 * Decide whether a message sender is a configured admin.
 *
 * Local match against ADMIN_USERNAMES/ADMIN_USER_IDS when either is set
 * (no network call); otherwise falls back to the getChatMember API lookup.
 */
export async function isAdminUser(
  env: Env,
  msg: Pick<TelegramMessage, 'from' | 'chat'>,
): Promise<boolean> {
  if (!msg.from) return false;

  const configured = configuredAdminSet(env);
  const idList = envList(env.ADMIN_USER_IDS);
  if (!configured && !idList.length) {
    // Neither list configured -> fall back to the API.
    return isAdmin(env, msg.chat.id, msg.from.id);
  }

  const username = msg.from.username?.toLowerCase();
  if (configured && username && configured.has(username)) return true;
  if (idList.length) {
    const id = Number(msg.from.id);
    if (Number.isInteger(id) && id > 0 && idList.includes(String(id))) return true;
  }
  return false;
}
/* Rich sending: chunked HTML posts, member count, admin DMs            */
/* ------------------------------------------------------------------ */

/** Telegram hard cap on a single message (post-parse). */
export const TG_TEXT_LIMIT = 4096;

/** Result of a detailed send: first-chunk message_id + overall status. */
export interface SendResult {
  ok: boolean;
  messageId?: number;
  description?: string;
}

/**
 * Split a text into chunks of at most `limit` characters, preferring line
 * boundaries so HTML entity blocks (item bullets) are not cut mid-tag.
 * If a single line exceeds the limit it is hard-split. Returns ≥1 chunk.
 */
export function chunkText(text: string, limit = TG_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit; // no good line boundary — hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * sendMessage variant for the digest: HTML parse mode, optional link-preview
 * suppression, automatic 4096-char chunking (multi-part posts get a "k/n"
 * marker on continuation chunks), and one retry honoring Telegram's 429
 * retry_after. Returns the message_id of the FIRST chunk (the canonical
 * post used for analytics) plus overall ok.
 */
export async function sendMessageDetailed(
  env: Env,
  chatId: number | string,
  text: string,
  opts: { parseMode?: 'HTML'; disablePreview?: boolean } = {},
): Promise<SendResult> {
  const chunks = chunkText(text);
  let firstId: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const suffix =
      chunks.length > 1 ? `\n\n<i>[${i + 1}/${chunks.length}]</i>` : '';
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i] + suffix,
    };
    if (opts.parseMode) params.parse_mode = opts.parseMode;
    if (opts.disablePreview) {
      params.link_preview_options = { is_disabled: true };
    }
    let json = await callTelegram(env, 'sendMessage', params);
    // One polite retry on flood-wait.
    if (!json.ok && /retry after (\d+)/i.test(json.description ?? '')) {
      const after = Number(/retry after (\d+)/i.exec(json.description ?? '')?.[1]);
      if (Number.isFinite(after) && after <= 30) {
        await sleep((after + 1) * 1000);
        json = await callTelegram(env, 'sendMessage', params);
      }
    }
    if (!json.ok) {
      return {
        ok: false,
        messageId: firstId,
        description: json.description,
      };
    }
    if (firstId === undefined) {
      const id = (json.result as { message_id?: unknown } | undefined)
        ?.message_id;
      if (typeof id === 'number') firstId = id;
    }
  }
  return { ok: true, messageId: firstId };
}

/** Current member count of a chat (channels/groups). Null on failure. */
export async function getChatMemberCount(
  env: Env,
  chatId: number | string,
): Promise<number | null> {
  const json = await callTelegram(env, 'getChatMemberCount', { chat_id: chatId });
  return typeof json.result === 'number' ? json.result : null;
}

/**
 * DM every numeric id in ADMIN_USER_IDS. Bots can only reach users who have
 * started the bot, so failures are expected and returned (not thrown) —
 * the caller logs them at debug level. Pass 'HTML' when the text carries
 * markup (without a parse mode Telegram shows the tags literally).
 */
export async function notifyAdmins(
  env: Env,
  text: string,
  parseMode?: 'HTML',
): Promise<{ sent: number; failed: number }> {
  const ids = (env.ADMIN_USER_IDS ?? '')
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const r = await sendMessageDetailed(env, id, text, {
      disablePreview: true,
      parseMode,
    });
    if (r.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

