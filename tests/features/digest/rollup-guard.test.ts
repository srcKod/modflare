import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDigest } from '../../../src/features/digest/pipeline';
import { resolveDigestConfig } from '../../../src/features/digest/config';
import type { AuditLogger } from '../../../src/core/logger';
import type { Env } from '../../../src/core/types';

// Review 1, P1-7: a weekly/monthly run with <3 history rows used to fall
// through into a fresh gather and publish mislabeled content under a rollup
// slot key. It must skip with history_too_short instead — before any
// engine fetch or LLM call.

function stubDb(seen: string[]) {
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { last_row_id: 1, changes: 1 } }),
  };
  return {
    prepare: (sql: string) => {
      seen.push(sql);
      return stmt;
    },
  } as unknown as D1Database;
}

function fakeLogger(calls: { event: string; fields?: object }[]): AuditLogger {
  const push = (event: string, fields?: object) => {
    calls.push({ event, fields });
  };
  return {
    debug: async (e: string, f?: object) => push(e, f),
    info: async (e: string, f?: object) => push(e, f),
    warn: async (e: string, f?: object) => push(e, f),
    error: async (e: string, f?: object) => push(e, f),
  } as unknown as AuditLogger;
}

describe('starved rollup skips instead of fresh-gathering', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no network past the history check');
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('weekly with <3 history rows logs history_too_short, no LLM, no row', async () => {
    const seen: string[] = [];
    const calls: { event: string; fields?: object }[] = [];
    const env = {
      DB: stubDb(seen),
      TIMEZONE: 'Asia/Baghdad',
      NEWS_TARGET_CHAT_ID: '-1001',
    } as unknown as Env;
    const cfg = resolveDigestConfig(env);
    await runDigest(env, cfg, 'weekly', fakeLogger(calls));
    const skip = calls.find((c) => c.event === 'news_skipped');
    expect(skip).toBeDefined();
    expect(skip?.fields).toMatchObject({ reason: 'history_too_short' });
    expect(seen.some((s) => s.includes('INSERT INTO digest_posts'))).toBe(false);
  });
});
