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

/** True if the message text/caption contains a URL (http/https). */
function hasLink(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
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
    // A zero-length window matches nothing (or everything? -> nothing, safer).
    return false;
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Cross-midnight: e.g. start=22, end=6 -> active if hour>=22 || hour<6.
  return hour >= start || hour < end;
}