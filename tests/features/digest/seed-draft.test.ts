import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDigestFromHour } from '../../../src/features/digest/pipeline';
import type { Env } from '../../../src/core/types';

// Review 1, P0-2: the dev-seed endpoint runs the REAL pipeline, so with
// NEWS_AUTO_PUBLISH=true a seed used to publish LIVE to the channel. The fix
// forces draft mode inside runDigestFromHour. This test runs the pipeline
// end-to-end on stubs (canned gnews RSS + canned LLM answer) with
// auto-publish ON and fails if ANY Telegram send is attempted.

const GNEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>
<item><title>First test story</title><link>https://example.com/first-story</link><pubDate>Tue, 16 Sep 2026 05:00:00 GMT</pubDate><source url="https://example.com">Example</source><description>First story snippet with enough characters to be useful for the digest pipeline test run.</description></item>
<item><title>Second test story</title><link>https://example.com/second-story</link><pubDate>Tue, 16 Sep 2026 04:00:00 GMT</pubDate><source url="https://example.org">ExampleOrg</source><description>Second story snippet with enough characters to be useful for the digest pipeline test run.</description></item>
</channel></rss>`;

const LLM_BODY = JSON.stringify({
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: 'Test digest',
          post: '<b>Seeded</b> first story summary <a href="s1"><i>Example</i></a>',
          items: [{ n: 1, title: 'First test story' }],
        }),
      },
      finish_reason: 'stop',
    },
  ],
});

function stubFetch(bodies?: string[]) {
  return vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    // Any Telegram send = the test fails (seed must stay a draft).
    if (u.includes('api.telegram.org')) {
      throw new Error('seed attempted a live Telegram send');
    }
    if (u.includes('chat/completions') && bodies && typeof init?.body === 'string') {
      bodies.push(init.body);
    }
    if (u.includes('news.google.com')) {
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => GNEWS_XML,
        json: async (): Promise<unknown> => null,
      };
    }
    if (u.includes('chat/completions')) {
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => LLM_BODY,
        json: async (): Promise<unknown> => JSON.parse(LLM_BODY),
      };
    }
    return {
      ok: false,
      status: 500,
      text: async (): Promise<string> => '',
      json: async (): Promise<unknown> => null,
    };
  });
}

/** D1 stub recording every prepared statement for post-run assertions. */
function stubDb(
  seen: string[],
  settingsRows: { key: string; value: string }[] = [],
  bound: { sql: string; args: unknown[] }[] = [],
  deepRows: object[] = [],
) {
  return {
    prepare: (sql: string) => {
      seen.push(sql);
      const stmt = {
        bind: (...a: unknown[]) => {
          bound.push({ sql, args: a });
          return stmt;
        },
        first: async () => null,
        all: async () => ({
          results: sql.includes('FROM digest_items') ? deepRows : settingsRows,
        }),
        run: async () => ({ meta: { last_row_id: 7, changes: 1 } }),
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe('runDigestFromHour always drafts (never publishes)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', stubFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a draft row with auto-publish ON and no Telegram send', async () => {
    const seen: string[] = [];
    const env = {
      DB: stubDb(seen),
      TIMEZONE: 'Asia/Baghdad',
      NEWS_TARGET_CHAT_ID: '-1001341446217',
      NEWS_AUTO_PUBLISH: 'true', // the trap: seed must draft anyway
      DIGEST_BASE_URL: 'https://gateway.example/compat',
      DIGEST_API_KEY: 'k',
      DIGEST_MODEL: 'test-model',
    } as unknown as Env;
    const { slotKey } = await runDigestFromHour(env, 9, 'headlines');
    expect(slotKey).toMatch(/T09:headlines$/);
    // A draft row was archived (the publish path would have thrown on the
    // Telegram send stub first).
    expect(seen.some((s) => s.includes('INSERT INTO digest_posts'))).toBe(true);
  });

  it('rotation rebuild keeps runtime overrides (language reaches the prompt)', async () => {
    // Review 1, P1-4: the rotation path rebuilt the config from env only,
    // silently dropping D1 overrides (e.g. panel-changed language).
    const seen: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', stubFetch(bodies));
    const env = {
      DB: stubDb(seen, [{ key: 'digest_language', value: 'French' }]),
      TIMEZONE: 'Asia/Baghdad',
      NEWS_TARGET_CHAT_ID: '-1001341446217',
      NEWS_DOMAIN: 'round-robin',
      NEWS_AUTO_PUBLISH: 'true',
      DIGEST_BASE_URL: 'https://gateway.example/compat',
      DIGEST_API_KEY: 'k',
      DIGEST_MODEL: 'test-model',
    } as unknown as Env;
    await runDigestFromHour(env, 9, 'headlines');
    const prompt = bodies
      .map((b) => {
        try {
          const p = JSON.parse(b) as { messages?: { content?: unknown }[] };
          const c = p.messages?.[1]?.content;
          return typeof c === 'string' ? c : '';
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(prompt).toContain('French');
  });
});

describe('PDF extraction without keys skips the keyless Jina call', () => {
  // Review 1, P2-12: keyless Jina JSON-mode parse always fails, so the PDF
  // branch must not burn the subrequest at all when no key is configured.
  const PDF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>
<item><title>Interesting paper</title><link>https://example.com/paper.pdf</link><pubDate>Tue, 16 Sep 2026 05:00:00 GMT</pubDate><source url="https://example.com">Example</source></item>
</channel></rss>`;

  it('never fetches r.jina.ai keyless and still drafts', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url);
        urls.push(u);
        if (u.includes('api.telegram.org')) {
          throw new Error('seed attempted a live Telegram send');
        }
        if (u.includes('news.google.com')) {
          return {
            ok: true,
            status: 200,
            text: async (): Promise<string> => PDF_XML,
            json: async (): Promise<unknown> => null,
          };
        }
        if (u.includes('chat/completions')) {
          return {
            ok: true,
            status: 200,
            text: async (): Promise<string> => LLM_BODY,
            json: async (): Promise<unknown> => JSON.parse(LLM_BODY),
          };
        }
        return {
          ok: false,
          status: 500,
          text: async (): Promise<string> => '',
          json: async (): Promise<unknown> => null,
        };
      }),
    );
    const seen: string[] = [];
    const env = {
      DB: stubDb(seen),
      TIMEZONE: 'Asia/Baghdad',
      NEWS_TARGET_CHAT_ID: '-1001341446217',
      NEWS_AUTO_PUBLISH: 'true',
      NEWS_FETCH_FULLTEXT: 'true',
      DIGEST_BASE_URL: 'https://gateway.example/compat',
      DIGEST_API_KEY: 'k',
      DIGEST_MODEL: 'test-model',
    } as unknown as Env;
    await runDigestFromHour(env, 9, 'headlines');
    expect(urls.some((u) => u.includes('r.jina.ai'))).toBe(false);
    expect(seen.some((s) => s.includes('INSERT INTO digest_posts'))).toBe(true);
  });
});

describe('deep slot under rotation takes no turn and no label', () => {
  // Deep analyzes the day's published items (whatever domains produced
  // them): no rotation rebuild (no COUNT cursor query), NULL stored domain.
  const DEEP_ROWS = [
    {
      url: 'https://example.com/deep-1',
      title: 'Deep one',
      source: 'Example',
      extracted_text: 'Full archived text of deep one with enough substance.',
    },
    {
      url: 'https://example.com/deep-2',
      title: 'Deep two',
      source: 'Example',
      extracted_text: 'Full archived text of deep two with enough substance.',
    },
  ];

  it('skips the rotation rebuild and stores a NULL domain', async () => {
    const seen: string[] = [];
    const bound: { sql: string; args: unknown[] }[] = [];
    const env = {
      DB: stubDb(seen, [], bound, DEEP_ROWS),
      TIMEZONE: 'Asia/Baghdad',
      NEWS_TARGET_CHAT_ID: '-1001341446217',
      NEWS_DOMAIN: 'round-robin',
      NEWS_AUTO_PUBLISH: 'true',
      DIGEST_BASE_URL: 'https://gateway.example/compat',
      DIGEST_API_KEY: 'k',
      DIGEST_MODEL: 'test-model',
    } as unknown as Env;
    const { slotKey } = await runDigestFromHour(env, 21, 'deep');
    expect(slotKey).toMatch(/T21:deep$/);
    // No rotation cursor query ran for the deep slot.
    expect(seen.some((s) => s.includes('COUNT(*)'))).toBe(false);
    // digest_posts bind order: slot_key, type, run_at, mode, domain, ...
    const postInsert = bound.find((b) => b.sql.includes('INSERT INTO digest_posts'));
    expect(postInsert).toBeDefined();
    expect(postInsert!.args[4]).toBeNull();
  });
});
