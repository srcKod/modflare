import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { moderationFeature } from '../../../src/features/moderation';
import type { Env, TelegramUpdate } from '../../../src/core/types';

/**
 * Hermetic fetch: the "switch stays ON" tests run past the switch into
 * isAdminUser, which falls back to a getChatMember API call when no admin
 * lists are configured. Without this stub that call hangs the suite in
 * network-less environments (5s vitest timeout). A Telegram-style
 * `{ok:false}` keeps the real path (not-admin → PROCESS_MODE skip).
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal group update that would pass every gate except the switch. */
function groupUpdate(): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: -1001, type: 'group', title: 'Test group' } as never,
      from: { id: 42, is_bot: false },
      text: 'hello',
    },
  } as TelegramUpdate;
}

/** D1 stub whose settings table holds optional rows. */
function dbStub(settings: Record<string, string>) {
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
  return {
    prepare: () => ({
      all: async () => ({ results: rows }),
    }),
  } as unknown as D1Database;
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function handler() {
  const update = moderationFeature.updates?.find(
    (u) => u.priority === 100,
  );
  return update?.handler as (
    env: Env,
    update: TelegramUpdate,
    logger: import('../../../src/core/logger').AuditLogger,
  ) => Promise<boolean>;
}

describe('moderation master switch', () => {
  it('default: moderation stays ON (env unset, no override)', async () => {
    const dbg = vi.fn();
    const run = handler();
    // No DB, no env — the switch resolves to the coded default (true).
    const env = { DB: undefined, ENABLE_MODERATION: undefined } as unknown as Env;
    const ok = await run(env, groupUpdate(), {
      ...silentLogger,
      debug: dbg,
    } as never);
    expect(ok).toBe(true); // update always claimed
    // 'moderation_disabled' must NOT be logged when the switch is on.
    expect(dbg).not.toHaveBeenCalledWith('moderation_disabled', expect.anything());
    // It also must NOT have fallen into the whitelist/activation gates with a
    // settings read — the switch check is the first real gate after group-type.
  });

  it('a D1 override = false disables moderation and logs the skip', async () => {
    const dbg = vi.fn();
    const run = handler();
    const env = { DB: dbStub({ moderation_enabled: 'false' }) } as unknown as Env;
    const ok = await run(env, groupUpdate(), { ...silentLogger, debug: dbg } as never);
    expect(ok).toBe(true);
    expect(dbg).toHaveBeenCalledWith(
      'moderation_disabled',
      expect.objectContaining({ chat_id: -1001, message_id: 10 }),
    );
  });

  it('the ENABLE_MODERATION=false env var disables moderation', async () => {
    const dbg = vi.fn();
    const run = handler();
    const env = {
      DB: dbStub({}),
      ENABLE_MODERATION: 'false',
    } as unknown as Env;
    await run(env, groupUpdate(), { ...silentLogger, debug: dbg } as never);
    expect(dbg).toHaveBeenCalledWith(
      'moderation_disabled',
      expect.objectContaining({ chat_id: -1001 }),
    );
  });

  it('an explicit true env/override keeps moderation on', async () => {
    const dbg = vi.fn();
    const run = handler();
    const env = {
      DB: dbStub({ moderation_enabled: 'true' }),
    } as unknown as Env;
    await run(env, groupUpdate(), { ...silentLogger, debug: dbg } as never);
    expect(dbg).not.toHaveBeenCalledWith('moderation_disabled', expect.anything());
  });

  it('ENABLE_MODERATION=true env keeps moderation on even without D1', async () => {
    const dbg = vi.fn();
    const run = handler();
    const env = {
      DB: undefined,
      ENABLE_MODERATION: 'true',
    } as unknown as Env;
    await run(env, groupUpdate(), { ...silentLogger, debug: dbg } as never);
    expect(dbg).not.toHaveBeenCalledWith('moderation_disabled', expect.anything());
  });
});
