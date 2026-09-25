import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { moderationFeature } from '../../../src/features/moderation';
import type { Env, TelegramUpdate } from '../../../src/core/types';

/**
 * Safe-verdict logging policy (MODERATION_LOG_SAFE / moderation_log_safe):
 * by default an unflagged message leaves NO audit row — the group's own
 * Telegram history is the standing record. The toggle re-enables logging
 * episodically (clean training pairs for the CSV export). These tests drive
 * a real message through every gate to the LLM verdict.
 *
 * Fetch router: getChatMember → {ok:false} (isAdminUser fallback with no
 * admin lists: not-admin, no API-key network path); /chat/completions → the
 * canned moderation JSON verdict; deleteMessage → ok (for the flagged case).
 */
function stubFetch(llmContent: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/chat/completions')) {
        // ok:true is load-bearing: chatCompletion checks res.ok before parsing
        // (llm.ts:88) — without it the call fail-opens and never reaches the
        // verdict branches these tests exist to cover.
        return {
          ok: true,
          json: async () => ({
            choices: [
              { message: { content: llmContent }, finish_reason: 'stop' },
            ],
          }),
        };
      }
      if (u.includes('deleteMessage')) {
        return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      return { json: async () => ({ ok: false, description: 'Unauthorized' }) };
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A group update with a link so it passes the default PROCESS_MODE
 * (media-links) gate and reaches the LLM verdict.
 */
function groupUpdate(): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: -1001, type: 'group', title: 'Test group' } as never,
      from: { id: 42, is_bot: false },
      text: 'check https://example.com/page for details',
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

/** Env that gets a message through every gate to a real LLM verdict. */
function baseEnv(db: unknown): Env {
  return {
    DB: db,
    OPENAI_BASE_URL: 'https://llm.test/v1',
    OPENAI_API_KEY: 'test-key',
    TEXT_MODEL: 'test-text-model',
    MODEL_NAME: 'test-media-model',
  } as unknown as Env;
}

const SAFE_JSON = '{"flag": false, "reason": "clean"}';
const FLAG_JSON = '{"flag": true, "reason": "spam link"}';

describe('moderation safe-verdict logging', () => {
  it('default: safe verdict leaves no audit row (Telegram history is the record)', async () => {
    stubFetch(SAFE_JSON);
    const dbg = vi.fn();
    const info = vi.fn();
    const env = baseEnv(dbStub({})); // no override, env unset → default off
    await handler()(env, groupUpdate(), {
      ...silentLogger,
      debug: dbg,
      info,
    } as never);
    // Prove the message reached the verdict stage (not vacuously skipped).
    expect(dbg).toHaveBeenCalledWith('moderating', expect.anything());
    expect(info).not.toHaveBeenCalledWith('safe', expect.anything());
  });

  it('MODERATION_LOG_SAFE=true env logs the safe row with text + reply', async () => {
    stubFetch(SAFE_JSON);
    const info = vi.fn();
    const env = {
      ...baseEnv(dbStub({})),
      MODERATION_LOG_SAFE: 'true',
    } as unknown as Env;
    await handler()(env, groupUpdate(), {
      ...silentLogger,
      info,
    } as never);
    expect(info).toHaveBeenCalledWith(
      'safe',
      expect.objectContaining({
        decision: 'keep',
        reason: 'clean',
        message_text: 'check https://example.com/page for details',
        llm_response: SAFE_JSON,
      }),
    );
  });

  it('a D1 override (panel) logs the safe row without any env var', async () => {
    stubFetch(SAFE_JSON);
    const info = vi.fn();
    const env = baseEnv(dbStub({ moderation_log_safe: 'true' }));
    await handler()(env, groupUpdate(), {
      ...silentLogger,
      info,
    } as never);
    expect(info).toHaveBeenCalledWith('safe', expect.anything());
  });

  it('the panel override shadows the env var (panel true beats env false)', async () => {
    stubFetch(SAFE_JSON);
    const info = vi.fn();
    const env = {
      ...baseEnv(dbStub({ moderation_log_safe: 'true' })),
      MODERATION_LOG_SAFE: 'false',
    } as unknown as Env;
    await handler()(env, groupUpdate(), {
      ...silentLogger,
      info,
    } as never);
    expect(info).toHaveBeenCalledWith('safe', expect.anything());
  });

  it('flagged verdicts still log (flagged_deleted) with the toggle off', async () => {
    stubFetch(FLAG_JSON);
    const warn = vi.fn();
    const env = baseEnv(dbStub({})); // toggle off — must not matter
    await handler()(env, groupUpdate(), {
      ...silentLogger,
      warn,
    } as never);
    expect(warn).toHaveBeenCalledWith(
      'flagged_deleted',
      expect.objectContaining({ decision: 'delete', reason: 'spam link' }),
    );
  });
});
