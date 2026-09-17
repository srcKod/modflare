import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyAdmins } from '../../src/core/telegram';
import type { Env } from '../../src/core/types';

// The draft-ready / publish-failed admin DMs carry Telegram HTML. Without an
// explicit parse mode the Bot API renders the tags literally (production bug:
// admins received raw `<b>`/`<code>` text). These lock the passthrough.

function stubFetch(sent: { chatId: unknown; parseMode: unknown }[]) {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    try {
      const p = JSON.parse(String(init?.body ?? '{}')) as {
        chat_id?: unknown;
        parse_mode?: unknown;
      };
      sent.push({ chatId: p.chat_id, parseMode: p.parse_mode });
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      status: 200,
      text: async (): Promise<string> => '',
      json: async (): Promise<unknown> => ({ ok: true, result: { message_id: 1 } }),
    };
  });
}

describe('notifyAdmins parse-mode passthrough', () => {
  const sent: { chatId: unknown; parseMode: unknown }[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal('fetch', stubFetch(sent));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = { ADMIN_USER_IDS: '111, 222' } as unknown as Env;

  it("sends parse_mode HTML when asked (markup DM renders, not raw tags)", async () => {
    const r = await notifyAdmins(env, '<b>hi</b>', 'HTML');
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(sent.length).toBe(2);
    for (const s of sent) expect(s.parseMode).toBe('HTML');
  });

  it('omits parse_mode by default (plain-text callers unchanged)', async () => {
    await notifyAdmins(env, 'plain');
    expect(sent.length).toBe(2);
    for (const s of sent) expect(s.parseMode).toBeUndefined();
  });

  it('skips non-numeric ids without a send', async () => {
    const r = await notifyAdmins({ ADMIN_USER_IDS: 'abc, -5, 0' } as unknown as Env, 'x');
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(sent.length).toBe(0);
  });
});
