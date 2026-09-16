import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moderationFeature } from '../../../src/features/moderation';
import type { Env, TelegramUpdate } from '../../../src/core/types';

// Regression guard for the own-post exemption: the discussion-group copy of
// our channel digest post arrives as a GroupAnonymousBot forward
// (forward_from_chat = NEWS_TARGET_CHAT_ID). It must skip before any admin
// lookup or LLM call — with zero network. The fetch stub throws if touched,
// so this test proves the exemption costs nothing.

const CHANNEL_ID = -1001341446217;

function forwardUpdate(): TelegramUpdate {
  return {
    update_id: 7,
    message: {
      message_id: 200,
      chat: { id: -1001619940016, type: 'supergroup', title: 'Discussion' },
      from: { id: 1087968824, is_bot: true, username: 'GroupAnonymousBot' },
      forward_from_chat: { id: CHANNEL_ID },
      text: '📰 digest body with links https://example.com/a',
    },
  } as unknown as TelegramUpdate;
}

function dbStub() {
  return {
    prepare: () => ({ all: async () => ({ results: [] }) }),
  } as unknown as D1Database;
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function handler() {
  const update = moderationFeature.updates?.find((u) => u.priority === 100);
  return update?.handler as (
    env: Env,
    update: TelegramUpdate,
    logger: import('../../../src/core/logger').AuditLogger,
  ) => Promise<boolean>;
}

describe('own digest-post forward exemption', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network must not be touched');
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exempts the discussion-group forward of our channel post', async () => {
    const dbg = vi.fn();
    const env = {
      DB: dbStub(),
      NEWS_TARGET_CHAT_ID: String(CHANNEL_ID),
    } as unknown as Env;
    const ok = await handler()(env, forwardUpdate(), {
      ...silentLogger,
      debug: dbg,
    } as never);
    expect(ok).toBe(true);
    expect(dbg).toHaveBeenCalledWith(
      'self_post_exempt',
      expect.objectContaining({ chat_id: -1001619940016, message_id: 200 }),
    );
  });

  it('does not exempt forwards of other chats', async () => {
    const dbg = vi.fn();
    const env = {
      DB: dbStub(),
      NEWS_TARGET_CHAT_ID: String(CHANNEL_ID),
    } as unknown as Env;
    const update = forwardUpdate();
    (
      update.message as unknown as { forward_from_chat: { id: number } }
    ).forward_from_chat = { id: -999 };
    const ok = await handler()(env, update, {
      ...silentLogger,
      debug: dbg,
    } as never);
    expect(ok).toBe(true);
    expect(dbg).not.toHaveBeenCalledWith(
      'self_post_exempt',
      expect.anything(),
    );
  });

  it('no exemption when the target chat is unconfigured', async () => {
    const dbg = vi.fn();
    const env = { DB: dbStub() } as unknown as Env;
    const ok = await handler()(env, forwardUpdate(), {
      ...silentLogger,
      debug: dbg,
    } as never);
    expect(ok).toBe(true);
    expect(dbg).not.toHaveBeenCalledWith(
      'self_post_exempt',
      expect.anything(),
    );
  });
});
