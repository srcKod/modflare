import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/core/types';

// Review 1, P1-5: the panel's manual publish diverged from the pipeline
// (no RTL marks, env-only sponsor). Drive the real route handler with a
// draft row: the sent text must carry RLM marks on RTL lines and the
// override-aware (settings-row) sponsor, never the env one.

// NOTE: handleDraftsRoute is reached through the module's route table (not
// exported directly); resolve it the same way the admin shell does.
import { digestAdminRoutes } from '../../../src/features/digest/admin';

const DRAFT_BODY = 'مرحبا بالعالم\nSecond line <b>bold</b>';

function stubDb(status = 'draft', sponsor = 'panel-sponsor') {
  const row = {
    id: 5,
    slot_key: '2026-09-16T09:headlines',
    type: 'daily',
    title: 't',
    body: DRAFT_BODY,
    status,
    target_chat_id: '-1001',
    body_original: DRAFT_BODY,
  };
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: async () => row,
    all: async () => ({ results: [{ key: 'digest_sponsor', value: sponsor }] }),
    run: async () => ({ meta: { last_row_id: 5, changes: 1 } }),
  };
  return {
    prepare: (_sql: string) => stmt,
  } as unknown as D1Database;
}

describe('panel manual publish matches the pipeline contract', () => {
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        if (typeof init?.body === 'string') {
          try {
            const p = JSON.parse(init.body) as { text?: string };
            if (typeof p.text === 'string') sent.push(p.text);
          } catch {
            /* ignore */
          }
        }
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => '',
          json: async (): Promise<unknown> => ({ ok: true, result: { message_id: 99 } }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies RTL marks and the override sponsor', async () => {
    const env = {
      DB: stubDb(),
      NEWS_SPONSOR_TEXT: 'env-sponsor-must-not-appear',
    } as unknown as Env;
    const route = digestAdminRoutes.find(
      (r) => r.method === 'POST' && r.prefix === '/api/digest/drafts',
    );
    expect(route).toBeDefined();
    const req = new Request('http://localhost/admin/api/digest/drafts/5/publish', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Origin: 'http://localhost' },
    });
    const res = await route!.handler(req, env);
    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
    // RTL line carries the RLM mark exactly like pipeline output.
    expect(sent[0]).toContain('\u200Fمرحبا');
    // Sponsor comes from the settings override, not the env var.
    expect(sent[0]).toContain('panel-sponsor');
    expect(sent[0]).not.toContain('env-sponsor-must-not-appear');
  });

  it('renders a named link from an HTML sponsor (sanitized, not escaped)', async () => {
    const env = {
      DB: stubDb('draft', 'Brought to you by <a href="https://github.com/srcKod/modflare">Modflare</a>'),
    } as unknown as Env;
    const route = digestAdminRoutes.find(
      (r) => r.method === 'POST' && r.prefix === '/api/digest/drafts',
    );
    const req = new Request('http://localhost/admin/api/digest/drafts/5/publish', {
      method: 'POST',
      headers: { 'X-Requested-With': 'fetch', Origin: 'http://localhost' },
    });
    const res = await route!.handler(req, env);
    expect(res.status).toBe(200);
    expect(sent[0]).toContain(
      '<a href="https://github.com/srcKod/modflare">Modflare</a>',
    );
  });
});

describe('failed-row retry', () => {
  // Review 1, P1-8: plan §11.4's regenerate promise for failed sends —
  // retry re-sends the stored body through the same contract, no LLM.
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        if (typeof init?.body === 'string') sent.push(init.body);
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => '',
          json: async (): Promise<unknown> => ({ ok: true, result: { message_id: 100 } }),
        };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function act(status: string, action: string) {
    const env = { DB: stubDb(status) } as unknown as Env;
    const route = digestAdminRoutes.find(
      (r) => r.method === 'POST' && r.prefix === '/api/digest/drafts',
    )!;
    return route.handler(
      new Request(`http://localhost/admin/api/digest/drafts/5/${action}`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch', Origin: 'http://localhost' },
      }),
      env,
    );
  }

  it('retry re-sends a failed row', async () => {
    const res = await act('failed', 'retry');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'retry' });
    expect(sent.length).toBe(1);
  });

  it('retry on a draft is rejected', async () => {
    const res = await act('draft', 'retry');
    expect(res.status).toBe(409);
    expect(sent.length).toBe(0);
  });

  it('publish on a failed row is rejected', async () => {
    const res = await act('failed', 'publish');
    expect(res.status).toBe(409);
    expect(sent.length).toBe(0);
  });
});

describe('draft load carries the static target name', () => {
  // The publish confirm shows the configured channel name, not the raw id —
  // served from static config on the row (no live Telegram lookup).
  async function loadOne(settingsRows: { key: string; value: string }[]) {
    const stmt = {
      bind: (..._a: unknown[]) => stmt,
      first: async () => ({
        id: 5,
        slot_key: 's',
        type: 'daily',
        title: 't',
        body: 'b',
        body_original: 'b',
        status: 'draft',
        target_chat_id: '-1001',
      }),
      all: async () => ({ results: settingsRows }),
      run: async () => ({ meta: {} }),
    };
    const route = digestAdminRoutes.find(
      (r) => r.method === 'GET' && r.prefix === '/api/digest/drafts',
    )!;
    const res = await route.handler(
      new Request('http://localhost/admin/api/digest/drafts/5'),
      { DB: { prepare: (_s: string) => stmt } as unknown as D1Database } as unknown as Env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { target_name: string | null };
  }

  it('override name wins', async () => {
    const row = await loadOne([{ key: 'digest_target_name', value: 'My Channel' }]);
    expect(row.target_name).toBe('My Channel');
  });

  it('null when unconfigured', async () => {
    const row = await loadOne([]);
    expect(row.target_name).toBeNull();
  });
});

describe('digest list header honors runtime overrides', () => {
  // Review 1, P1-6: the header toggles read env-only and went stale once the
  // Settings tab shadowed them.
  async function listHeader(env: Env, settingsRows: { key: string; value: string }[]) {
    const stmt = {
      bind: (..._a: unknown[]) => stmt,
      first: async () => null,
      all: async () => ({ results: settingsRows }),
      run: async () => ({ meta: {} }),
    };
    const dbEnv = {
      ...env,
      DB: { prepare: (_sql: string) => stmt } as unknown as D1Database,
    } as unknown as Env;
    const route = digestAdminRoutes.find(
      (r) => r.method === 'GET' && r.prefix === '/api/digest/drafts',
    )!;
    const res = await route.handler(
      new Request('http://localhost/admin/api/digest/drafts'),
      dbEnv,
    );
    return (await res.json()) as { auto_publish: boolean; enabled: boolean };
  }

  it('override true wins over unset env', async () => {
    const h = await listHeader({} as unknown as Env, [
      { key: 'digest_autopublish', value: 'true' },
      { key: 'digest_enabled', value: 'true' },
    ]);
    expect(h.auto_publish).toBe(true);
    expect(h.enabled).toBe(true);
  });

  it('override false wins over env true', async () => {
    const h = await listHeader(
      { NEWS_AUTO_PUBLISH: 'true', ENABLE_NEWS_DIGEST: 'true' } as unknown as Env,
      [
        { key: 'digest_autopublish', value: 'false' },
        { key: 'digest_enabled', value: 'false' },
      ],
    );
    expect(h.auto_publish).toBe(false);
    expect(h.enabled).toBe(false);
  });
});
