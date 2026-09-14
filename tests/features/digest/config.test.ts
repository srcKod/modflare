import { describe, expect, it } from 'vitest';
import {
  isRotationDomain,
  parseReactionSignals,
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
    expect(ROTATION_PRESETS).toContain('tech-zh');
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
