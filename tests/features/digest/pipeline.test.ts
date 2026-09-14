import { describe, expect, it } from 'vitest';
import { computeSlotKey } from '../../../src/features/digest/pipeline';

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
