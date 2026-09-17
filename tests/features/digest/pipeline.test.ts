import { describe, expect, it } from 'vitest';
import {
  computeSlotKey,
  postDomainFor,
  resolveDigestType,
} from '../../../src/features/digest/pipeline';

describe('computeSlotKey', () => {
  it('builds a daily key from date + hour', () => {
    expect(computeSlotKey('daily', { date: '2026-09-13', hour: 9 })).toBe('2026-09-13T09');
  });

  it('builds ISO-week and month keys for rollups', () => {
    expect(computeSlotKey('weekly', { date: '2026-09-13', hour: 9 })).toMatch(/^weekly-\d{4}-W\d{2}$/);
    expect(computeSlotKey('monthly', { date: '2026-09-13', hour: 9 })).toBe('monthly-2026-09');
  });

  it('appends the intraday tag so same-day slots do not collide', () => {
    const lp = { date: '2026-09-13', hour: 9 };
    const headlines = computeSlotKey('daily', lp, 'headlines');
    const papers = computeSlotKey('daily', { date: '2026-09-13', hour: 14 }, 'papers');
    const trending = computeSlotKey('daily', { date: '2026-09-13', hour: 20 }, 'trending');

    expect(headlines).toBe('2026-09-13T09:headlines');
    expect(papers).toBe('2026-09-13T14:papers');
    expect(trending).toBe('2026-09-13T20:trending');
    // All distinct on the same day:
    expect(new Set([headlines, papers, trending]).size).toBe(3);
  });

  it('keeps legacy keys tag-less when no tag is given', () => {
    expect(computeSlotKey('daily', { date: '2026-09-13', hour: 9 })).toBe(
      computeSlotKey('daily', { date: '2026-09-13', hour: 9 }, undefined),
    );
  });
});

describe('runDigestFromHour slot-key shape', () => {
  // The dev-seed endpoint executes the real pipeline from a chosen hour; its
  // contract is that the resulting slot key equals what the cron tick at that
  // hour would produce (date + hour + tag), so a seeded draft collides with —
  // i.e. verifies exactly the slot the schedule owns.
  const lp = { date: '2026-09-15', hour: 9 };
  it('tags the slot key with the chosen tag (intraday shape)', () => {
    expect(computeSlotKey('daily', lp, 'headlines')).toBe('2026-09-15T09:headlines');
    expect(computeSlotKey('daily', lp, 'deep')).toBe('2026-09-15T09:deep');
  });

  it('uses the chosen hour, not the current wall-clock hour', () => {
    // lp.hour is what runDigestFromHour overrides localParts with.
    expect(computeSlotKey('daily', { date: '2026-09-15', hour: 21 }, 'trending'))
      .toBe('2026-09-15T21:trending');
  });
});

describe('resolveDigestType', () => {
  // Review 1, P0-1: an hour that owns no slot must resolve to null (silent
  // gate no-op) — never to an untagged full digest. The old fallthrough
  // published around the clock (9 channel posts vs 4 scheduled, 2026-09-16).
  const schedEnv = {
    NEWS_SCHEDULE: '9:headlines,12:trending,14:papers,21:deep',
  } as never;
  const plainCfg = {
    monthlyEnabled: false,
    weeklyEnabled: false,
    monthlyDay: 1,
    weeklyDay: 0,
  };
  const lp = (hour: number, weekday = 2, day = 16) => ({
    date: '2026-09-16',
    hour,
    weekday,
    day,
  });

  it('returns the scheduled slot for a scheduled hour', () => {
    const r = resolveDigestType(schedEnv, plainCfg as never, lp(9));
    expect(r?.type).toBe('daily');
    expect(r?.slot?.tag).toBe('headlines');
  });

  it('returns null for an off-schedule hour', () => {
    expect(resolveDigestType(schedEnv, plainCfg as never, lp(10))).toBeNull();
    expect(resolveDigestType(schedEnv, plainCfg as never, lp(22))).toBeNull();
  });

  it('returns null when no schedule is set', () => {
    expect(resolveDigestType({} as never, plainCfg as never, lp(9))).toBeNull();
  });

  it('weekly wins over the intraday slot at the rollup hour', () => {
    const cfg = { ...plainCfg, weeklyEnabled: true, weeklyDay: 2 } as never;
    expect(resolveDigestType(schedEnv, cfg, lp(9))).toEqual({ type: 'weekly' });
  });

  it('monthly wins over weekly', () => {
    const cfg = {
      ...plainCfg,
      monthlyEnabled: true,
      monthlyDay: 16,
      weeklyEnabled: true,
      weeklyDay: 2,
    } as never;
    expect(resolveDigestType(schedEnv, cfg, lp(9))).toEqual({ type: 'monthly' });
  });
});

describe('postDomainFor', () => {
  // Review 1, P2-19: rollups synthesize cross-domain history — labeling one
  // with a rotation-picked domain misleads the filter and future retrieval.
  it('labels daily runs, nulls rollups', () => {
    const cfg = { effectiveDomain: 'tech' } as never;
    expect(postDomainFor(cfg, 'daily')).toBe('tech');
    expect(postDomainFor(cfg, 'weekly')).toBeNull();
    expect(postDomainFor(cfg, 'monthly')).toBeNull();
  });
});
