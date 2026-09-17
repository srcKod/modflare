import { describe, expect, it } from 'vitest';
import {
  isRotationDomain,
  parseReactionSignals,
  parseSchedule,
  rollupHourFromSchedule,
  DOMAIN_PRESETS,
  ROTATION_PRESETS,
} from '../../../src/features/digest/config';
import { resolveDigestConfig } from '../../../src/features/digest/config';
import { resolveSlotDomain } from '../../../src/features/digest/pipeline';

/** Minimal D1 stub covering the single COUNT query resolveSlotDomain makes. */
const stubDb = (count: number) =>
  ({
    prepare: () => ({
      bind: (..._b: unknown[]) => ({
        first: async () => ({ c: count }),
      }),
      first: async () => ({ c: count }),
    }),
  }) as unknown as D1Database;

const envWith = (domain: string) =>
  ({ NEWS_DOMAIN: domain }) as unknown as Parameters<typeof resolveSlotDomain>[0];

describe('isRotationDomain', () => {
  it('recognizes the strategy values (with `all` alias + case/space tolerance)', () => {
    expect(isRotationDomain('round-robin')).toBe(true);
    expect(isRotationDomain('random')).toBe(true);
    expect(isRotationDomain('all')).toBe(true);
    expect(isRotationDomain('  RANDOM ')).toBe(true);
  });

  it('treats presets and unknown values as fixed domains', () => {
    expect(isRotationDomain('tech')).toBe(false);
    expect(isRotationDomain('tech-zh')).toBe(false);
    expect(isRotationDomain('finance')).toBe(false);
    expect(isRotationDomain('')).toBe(false);
  });
});

describe('ROTATION_PRESETS', () => {
  it('exposes every preset except `custom`', () => {
    expect(ROTATION_PRESETS).toContain('tech');
    expect(ROTATION_PRESETS).not.toContain('tech-zh'); // merged into `tech`
    expect(ROTATION_PRESETS).not.toContain('custom');
  });
});

describe('parseReactionSignals', () => {
  it('returns the built-in map when nothing is configured', () => {
    const m = parseReactionSignals(undefined);
    expect(m['\u{1F44D}']).toBe('pos'); // 👍
    expect(m['\u{1F44E}']).toBe('neg'); // 👎
  });

  it('merges custom emoji:pos/neg pairs over the defaults', () => {
    const m = parseReactionSignals('\u{1F680}:pos'); // 🚀
    expect(m['\u{1F680}']).toBe('pos');
    expect(m['\u{1F44D}']).toBe('pos'); // default retained
  });

  it('can demote a default-positive emoji to neutral', () => {
    const m = parseReactionSignals('\u{1F525}:neutral'); // 🔥
    expect(m['\u{1F525}']).toBeUndefined();
  });

  it('ignores malformed pairs', () => {
    const m = parseReactionSignals('broken, \u{1F31F}:maybe');
    expect(m['\u{1F31F}']).toBeUndefined();
    expect(m['\u{1F44D}']).toBe('pos'); // defaults survive bad input
  });
});

describe('resolveSlotDomain', () => {
  it('passes a fixed preset through unchanged', async () => {
    expect(await resolveSlotDomain(envWith('tech'), stubDb(0), 's')).toBe('tech');
    expect(await resolveSlotDomain(envWith('finance'), stubDb(9), 's')).toBe('finance');
  });

  it('round-robin walks the preset list by attempted-slot cursor', async () => {
    const env = envWith('round-robin');
    for (let i = 0; i < ROTATION_PRESETS.length * 2; i++) {
      const picked = await resolveSlotDomain(env, stubDb(i), 'slot');
      expect(picked).toBe(ROTATION_PRESETS[i % ROTATION_PRESETS.length]);
    }
  });

  it('`all` aliases round-robin', async () => {
    const first = await resolveSlotDomain(envWith('all'), stubDb(0), 'x');
    const rr = await resolveSlotDomain(envWith('round-robin'), stubDb(0), 'x');
    expect(first).toBe(rr);
  });

  it('round-robin walks only the merged preset list (no tech-zh)', async () => {
    // The cursor math is modulo the preset count; merging tech-zh into tech
    // must not leave a dangling entry in the rotation list.
    const env = envWith('round-robin');
    const seen = new Set<string>();
    for (let i = 0; i < ROTATION_PRESETS.length + 1; i++) {
      seen.add(await resolveSlotDomain(env, stubDb(i), 'slot'));
    }
    expect(seen.has('tech-zh')).toBe(false);
    expect(seen.has('tech')).toBe(true);
  });

  it('random is slot-deterministic (retry-safe) and within the preset list', async () => {
    const env = envWith('random');
    const a = await resolveSlotDomain(env, stubDb(0), '2026-09-13T09');
    const b = await resolveSlotDomain(env, stubDb(5), '2026-09-13T09');
    expect(a).toBe(b); // same slot → same domain regardless of cursor
    expect(ROTATION_PRESETS).toContain(a);
    // Different slots spread across the list (not literally constant):
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      picks.add(await resolveSlotDomain(env, stubDb(0), `slot-${i}`));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('round-robin cursor scopes to one chat when a chat id is given', async () => {
    // Review 1, P2-15: multi-chat rotation must not share one global cursor.
    const seenSql: string[] = [];
    const seenBinds: unknown[][] = [];
    const chatDb = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        return {
          bind: (...b: unknown[]) => {
            seenBinds.push(b);
            return { first: async () => ({ c: 1 }) };
          },
          first: async () => ({ c: 1 }),
        };
      },
    } as unknown as D1Database;
    const env = envWith('round-robin');
    const picked = await resolveSlotDomain(env, chatDb, 'slot', '-1001');
    expect(picked).toBe(ROTATION_PRESETS[1]);
    expect(seenSql.some((s) => s.includes('target_chat_id'))).toBe(true);
    expect(seenBinds.some((b) => b.includes('-1001'))).toBe(true);
    // Deep (analysis) slots never advance the rotation cursor.
    expect(seenSql.some((s) => s.includes("slot_key NOT LIKE '%:deep'"))).toBe(true);
  });

  it('round-robin keeps the global cursor when no chat id is given', async () => {
    const seenSql: string[] = [];
    const chatDb = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        return {
          bind: (..._b: unknown[]) => ({ first: async () => ({ c: 2 }) }),
          first: async () => ({ c: 2 }),
        };
      },
    } as unknown as D1Database;
    const picked = await resolveSlotDomain(envWith('round-robin'), chatDb, 'slot');
    expect(picked).toBe(ROTATION_PRESETS[2]);
    expect(seenSql.some((s) => s.includes('target_chat_id'))).toBe(false);
  });
});

describe('parseSchedule (NEWS_SCHEDULE)', () => {
  it('returns an empty schedule when unset', () => {
    expect(parseSchedule(undefined)).toEqual({});
    expect(parseSchedule('')).toEqual({});
  });

  it('parses hour:tag pairs into a hour-keyed map', () => {
    const s = parseSchedule('9:headlines,14:papers,20:trending');
    expect(Object.keys(s).map(Number).sort((a, b) => a - b)).toEqual([9, 14, 20]);
    expect(s[9].tag).toBe('headlines');
    expect(s[9].mode).toBe('news');
    expect(s[14].tag).toBe('papers');
    expect(s[14].mode).toBe('papers');
    expect(s[20].tag).toBe('trending');
  });

  it('assigns each tag its engine set', () => {
    const s = parseSchedule('9:headlines,14:papers,20:trending');
    // headlines → broad news engines (paid ones no-op without a key)
    expect(s[9].newsEngines).toContain('gnews');
    expect(s[9].newsEngines).toContain('rss');
    expect(s[9].scholarEngines).toEqual([]);
    // papers → scholar only (arxiv + hf + Semantic Scholar)
    expect(s[14].newsEngines).toEqual([]);
    expect(s[14].scholarEngines).toEqual(['arxiv', 'hf', 's2']);
    // trending → hn only
    expect(s[20].newsEngines).toEqual(['hn']);
  });

  it('keeps trending topic-agnostic so HN match-all returns hits', () => {
    const s = parseSchedule('9:headlines,20:trending');
    // Regression guard: an HN Algolia query intersects topics with titles via
    // full-text matching, and generic topic phrases ("artificial intelligence")
    // never appear verbatim in HN titles — so any inherited topic filter makes
    // the query return zero hits and the slot silently skips with no_candidates.
    // trending must therefore gather match-all (empty topics → query=).
    expect(s[20].topics).toEqual([]);
    // headlines, by contrast, is keyword-targeted — it must NOT pin topics so it
    // inherits the resolved preset's topic list.
    expect(s[9].topics).toBeUndefined();
  });

  it('parses the deep tag with a higher per-slot token budget and empty engines', () => {
    const s = parseSchedule('9:headlines,21:deep');
    expect(s[21].tag).toBe('deep');
    // Deep is D1-sourced — it gathers nothing and spends its budget on a
    // richer prompt instead.
    expect(s[21].newsEngines).toEqual([]);
    expect(s[21].scholarEngines).toEqual([]);
    expect(s[21].maxTokens).toBe(5000);
    // Daily slots carry the standard budget.
    expect(s[9].maxTokens).toBe(3000);
    // Headlines slot includes the key-gated jsearch engine.
    expect(s[9].newsEngines).toContain('jsearch');
  });

  it('rolls up (weekly/monthly) at the earliest scheduled hour', () => {
    // "morning roundup" — derived, replacing the removed NEWS_PUBLISH_HOURS.
    const s = parseSchedule('9:headlines,5:papers,20:trending');
    expect(rollupHourFromSchedule(s)).toBe(5);
    expect(rollupHourFromSchedule({})).toBeNull();
  });

  it('gives every rotation-eligible preset arXiv categories so papers slots survive rotation', () => {
    // Regression guard: empty arxivCats make the arXiv engine no-op, so a
    // papers slot under a rotation-picked finance/health day would lose its
    // arXiv source entirely.
    for (const preset of ROTATION_PRESETS) {
      expect(DOMAIN_PRESETS[preset].arxivCats.length).toBeGreaterThan(0);
    }
  });

  it('skips malformed entries, out-of-range hours and unknown tags', () => {
    const s = parseSchedule('9:headlines,abc,25:papers,4:banana,14:');
    expect(s[9].tag).toBe('headlines');
    expect(s[14]).toBeUndefined(); // no tag after colon
    expect(s[25]).toBeUndefined(); // hour out of range
    expect(s[4]).toBeUndefined(); // unknown tag
  });

  it('is tolerant of surrounding whitespace (no spaces around the colon — envList splits on whitespace)', () => {
    // `hour:tag` is one token; envList splits on commas/whitespace, so the
    // colon must stay glued to its hour and tag.
    const s = parseSchedule('  9:headlines , 14:papers  ');
    expect(s[9].tag).toBe('headlines');
    expect(s[14].tag).toBe('papers');
  });
});

describe('digest LLM extra body is provider-scoped', () => {
  // Regression: the digest inherited the moderation thinking-off payload
  // (Workers AI `chat_template_kwargs`) via LLM_EXTRA_BODY_JSON fallback and
  // google-ai-studio rejected it with a 400. Provider payloads are not
  // portable - unset DIGEST_EXTRA_BODY_JSON must send a clean payload.
  const envBase = {
    OPENAI_BASE_URL: 'https://gateway.example/compat',
    OPENAI_API_KEY: 'k',
    DIGEST_BASE_URL: 'https://gateway.example/compat',
    DIGEST_API_KEY: 'k2',
    DIGEST_MODEL: 'google-ai-studio/gemini-3.5-flash-lite',
  };
  it('does not inherit the moderation thinking-off payload', () => {
    const cfg = resolveDigestConfig({
      ...envBase,
      LLM_EXTRA_BODY_JSON: '{"chat_template_kwargs":{"enable_thinking":false}}',
    } as never);
    expect(cfg.llm.extraBody).toBe('');
  });
  it('uses DIGEST_EXTRA_BODY_JSON verbatim when set', () => {
    const cfg = resolveDigestConfig({
      ...envBase,
      LLM_EXTRA_BODY_JSON: '{"chat_template_kwargs":{"enable_thinking":false}}',
      DIGEST_EXTRA_BODY_JSON: '{"thinkingConfig":{"thinkingBudget":0}}',
    } as never);
    expect(cfg.llm.extraBody).toBe('{"thinkingConfig":{"thinkingBudget":0}}');
  });
});
