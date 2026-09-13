import { describe, expect, it } from 'vitest';
import { isActivePeriod, shouldProcess } from '../../../src/features/moderation/scheduler';
import type { Env, TelegramMessage } from '../../../src/core/types';

const env = (over: Partial<Env>): Env =>
  ({ TIMEZONE: 'UTC', START_HOUR: 0, END_HOUR: 0, ...over }) as Env;

const msg = (over: Partial<TelegramMessage>): TelegramMessage =>
  ({ message_id: 1, date: 0, chat: { id: -100, type: 'supergroup' }, ...over }) as TelegramMessage;

const TEXT_LINK = 'docs live at https://example.com/handbook';
const TEXT_PLAIN = 'team update: standup moved to 4pm';

describe('shouldProcess (PROCESS_MODE filter)', () => {
  it("mode 'all' processes every message", () => {
    const e = env({ PROCESS_MODE: 'all' });
    expect(shouldProcess(e, msg({ text: TEXT_PLAIN }))).toBe(true);
    expect(shouldProcess(e, msg({ text: TEXT_LINK }))).toBe(true);
    expect(shouldProcess(e, msg({ photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] }))).toBe(true);
  });

  it("mode 'media' processes only media carriers", () => {
    const e = env({ PROCESS_MODE: 'media' });
    expect(shouldProcess(e, msg({ text: TEXT_LINK }))).toBe(false);
    expect(shouldProcess(e, msg({ text: TEXT_PLAIN }))).toBe(false);
    expect(shouldProcess(e, msg({ photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] }))).toBe(true);
    expect(shouldProcess(e, msg({ animation: { file_id: 'f' } }))).toBe(true);
  });

  it("mode 'links' processes only messages containing a URL-like token", () => {
    const e = env({ PROCESS_MODE: 'links' });
    expect(shouldProcess(e, msg({ text: TEXT_LINK }))).toBe(true);
    expect(shouldProcess(e, msg({ text: TEXT_PLAIN }))).toBe(false);
  });

  it("mode 'media-links' (default) processes media OR links, not plain text", () => {
    const e = env({}); // default is media-links
    expect(shouldProcess(e, msg({ text: TEXT_LINK }))).toBe(true);
    expect(shouldProcess(e, msg({ photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] }))).toBe(true);
    expect(shouldProcess(e, msg({ text: TEXT_PLAIN }))).toBe(false);
  });

  it('falls back to media-links on an invalid mode', () => {
    const e = env({ PROCESS_MODE: 'bogus' });
    expect(shouldProcess(e, msg({ text: TEXT_PLAIN }))).toBe(false);
    expect(shouldProcess(e, msg({ text: TEXT_LINK }))).toBe(true);
  });
});

describe('link detection (via shouldProcess in links mode)', () => {
  const e = env({ PROCESS_MODE: 'links' });
  const hasLink = (text: string) => shouldProcess(e, msg({ text }));

  it('detects scheme urls, www. forms, and bare domains', () => {
    expect(hasLink('see https://x.com/a')).toBe(true);
    expect(hasLink('go to www.example.com now')).toBe(true);
    expect(hasLink('visit example.com for docs')).toBe(true);
    expect(hasLink('mail contact@example.com')).toBe(true);
  });

  it('does not mistake filenames for domains', () => {
    expect(hasLink('see report.pdf attached')).toBe(false);
    expect(hasLink('run app.js to start')).toBe(false);
  });

  it('ignores plain text', () => {
    expect(hasLink(TEXT_PLAIN)).toBe(false);
  });
});

describe('isActivePeriod', () => {
  it('gates on a normal window [START, END) in the configured timezone', () => {
    const e = env({ START_HOUR: 9, END_HOUR: 18 });
    expect(isActivePeriod(e, new Date('2026-09-13T10:00:00Z'))).toBe(true);
    expect(isActivePeriod(e, new Date('2026-09-13T18:00:00Z'))).toBe(false);
  });

  it('handles cross-midnight windows', () => {
    const e = env({ START_HOUR: 22, END_HOUR: 6 });
    expect(isActivePeriod(e, new Date('2026-09-13T23:00:00Z'))).toBe(true);
    expect(isActivePeriod(e, new Date('2026-09-13T05:00:00Z'))).toBe(true);
    expect(isActivePeriod(e, new Date('2026-09-13T07:00:00Z'))).toBe(false);
  });

  it('treats START_HOUR === END_HOUR as always active', () => {
    const e = env({ START_HOUR: 0, END_HOUR: 0 });
    expect(isActivePeriod(e, new Date('2026-09-13T18:00:00Z'))).toBe(true);
  });
});
