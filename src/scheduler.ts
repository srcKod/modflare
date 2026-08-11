import type { Env, TelegramMessage } from './types';

/** Which messages should be sent to the LLM, driven by PROCESS_MODE. */
export type ProcessMode =
  | 'all'
  | 'media'
  | 'links'
  | 'media-links';

/** True if the message has any media (photo/video/animation/document). */
function hasMedia(
  msg: Pick<
    TelegramMessage,
    'photo' | 'video' | 'animation' | 'document'
  >,
): boolean {
  return Boolean(
    (msg.photo && msg.photo.length > 0) ||
      msg.video ||
      msg.animation ||
      msg.document,
  );
}

/** Explicit scheme URLs: http://, https://, tg://, ftp://, … */
const SCHEME_URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/i;

/** `www.` shorthand, scheme-less: www.example.com, www.example.com/path */
const WWW_URL_RE = /www\.[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*(?::\d+)?(?:\/[^\s]*)?/iu;

/**
 * Common filename extensions that look like bare domains (report.pdf,
 * photo.jpg, app.js, …) — excluded so plain text with file names is not
 * mistaken for a link.
 */
const FILE_EXTENSIONS =
  '(?:txt|md|jpg|jpeg|png|gif|svg|webp|bmp|ico|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|zip|rar|7z|tar|gz|bz2|mp3|mp4|avi|mkv|mov|wav|flac|ogg|exe|apk|ipa|dmg|iso|css|js|mjs|ts|jsx|tsx|json|xml|csv|html|htm|py|sh|bat|cmd|ps1|log|ini|cfg|conf|yaml|yml|tmp|bak|swp|lock)';

/**
 * Bare domain ending in an ASCII letter TLD (2+ chars): example.com,
 * t.me/joinchat/…, sub.example.co.uk/path, contact@example.com.
 * Leading boundary includes whitespace/punctuation/@ (so emails match and
 * Arabic text adjacent to the domain still counts); trailing boundary keeps
 * sentence punctuation out of the match.
 */
const BARE_DOMAIN_RE = new RegExp(
  `(?:^|[\\s([{<'"@])[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*\\.(?!${FILE_EXTENSIONS}\\b)([a-z]{2,63})(?::\\d+)?(?:\\/[^\\s]*)?(?:$|[\\s)\\]}>'".,;!?])`,
  'iu',
);

/**
 * True if the message text/caption contains a URL-like token: an explicit
 * scheme (http/https/tg/…), a `www.` domain, or a bare domain with a letter
 * TLD. Scheme-less domains (the common `www.X.com` / `X.com` spam shape)
 * are caught, while file names and version strings are not.
 */
function hasLink(text: string): boolean {
  if (!text) return false;
  if (SCHEME_URL_RE.test(text)) return true;
  if (WWW_URL_RE.test(text)) return true;
  return BARE_DOMAIN_RE.test(text);
}

/**
 * Decide whether a message should be processed based on PROCESS_MODE.
 * Defaults to 'media-links' when unset or invalid so we don't waste LLM
 * tokens on every plain-text message.
 */
export function shouldProcess(
  env: Env,
  msg: Pick<TelegramMessage, 'photo' | 'video' | 'animation' | 'document' | 'text' | 'caption'>,
): boolean {
  const mode = (env.PROCESS_MODE || 'media-links').trim().toLowerCase();
  const text = [msg.text, msg.caption].filter(Boolean).join(' ');
  const media = hasMedia(msg);
  const links = hasLink(text);

  switch (mode) {
    case 'all':
      return true;
    case 'media':
      return media;
    case 'links':
      return links;
    case 'media-links':
    default:
      return media || links;
  }
}

/**
 * Time-based activation gate.
 *
 * True only when the current hour (in the configured IANA timezone) falls
 * inside the active window [START_HOUR, END_HOUR). Handles cross-midnight
 * ranges (e.g. START=22, END=6 is active from 22:00 to 06:00).
 * Setting START_HOUR = END_HOUR enables 24-hour moderation.
 */
export function isActivePeriod(env: Env, now: Date = new Date()): boolean {
  const start = env.START_HOUR;
  const end = env.END_HOUR;

  // Resolve the hour in the target timezone without carrying about the date.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.TIMEZONE,
    hour: 'numeric',
    hourCycle: 'h23', // force 0-23
  }).formatToParts(now);

  const hourPart = parts.find((p) => p.type === 'hour');
  const hour = hourPart ? Number(hourPart.value) : Number.NaN;
  if (Number.isNaN(hour)) {
    // Fall back to UTC hour if the timezone is invalid.
    return isHourInRange(now.getUTCHours(), start, end);
  }

  return isHourInRange(hour, start, end);
}

/** Range check with cross-midnight support. */
function isHourInRange(hour: number, start: number, end: number): boolean {
  if (start === end) {
    // Same start and end = full 24-hour window.
    return true;
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Cross-midnight: e.g. start=22, end=6 -> active if hour>=22 || hour<6.
  return hour >= start || hour < end;
}