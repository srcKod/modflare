import { describe, expect, it } from 'vitest';
import {
  isRotationDomain,
  parseReactionSignals,
  parseSchedule,
  ROTATION_PRESETS,
} from '../../../src/features/digest/config';
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
    // papers → scholar only
    expect(s[14].newsEngines).toEqual([]);
    expect(s[14].scholarEngines).toEqual(['arxiv', 'hf']);
    // trending → hn only
    expect(s[20].newsEngines).toEqual(['hn']);
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
