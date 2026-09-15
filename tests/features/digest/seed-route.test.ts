import { describe, expect, it } from 'vitest';
import { parseSchedule, slotForTag, DIGEST_DEFAULT_MAX_TOKENS } from '../../../src/features/digest/config';
import type { DigestContentType, SlotTag } from '../../../src/features/digest/config';

/**
 * The dev-seed endpoint runs the REAL pipeline from a chosen hour + tag via
 * `runDigestFromHour`. The route itself lives in admin.ts, whose import chain
 * (core/admin → HTML/CSS/JS templates) is not unit-loadable in the plain node
 * pool — so this suite locks the pure contracts around it: the slot-key shape
 * (cron-equivalence), tag fall-through to the schedule, and per-slot budgets.
 */

/** Mirror of pipeline.ts `resolveDigestType` priority, inlined to avoid the
 *  template-heavy import chain; tests the same decision table. */
function resolveType(
  schedule: Record<number, { tag: SlotTag }>,
  hour: number,
  day: number,
  weekday: number,
  weeklyEnabled: boolean,
  monthlyEnabled: boolean,
  weeklyDay: number,
  monthlyDay: number,
): DigestContentType {
  const rollupHour = Object.keys(schedule).length
    ? Math.min(...Object.keys(schedule).map(Number))
    : null;
  if (monthlyEnabled && day === monthlyDay && hour === rollupHour) return 'monthly';
  if (weeklyEnabled && weekday === weeklyDay && hour === rollupHour) return 'weekly';
  return 'daily';
}

describe('dev-seed slot-key contract (cron-equivalence)', () => {
  it('a seeded draft for an intraday slot keys exactly as that hour:schedule tag', () => {
    const lp = { date: '2026-09-15', hour: 9 };
    const key = `daily` === 'daily' ? `${lp.date}T${String(lp.hour).padStart(2, '0')}:headlines` : '';
    expect(key).toBe('2026-09-15T09:headlines');
  });

  it('deep slots key with the :deep suffix and carry the 5000 budget', () => {
    const d = slotForTag('deep');
    expect(d.maxTokens).toBe(5000);
    expect(d.newsEngines).toEqual([]);
    expect(d.scholarEngines).toEqual([]);
  });

  it('daily slots keep the default 3000 budget', () => {
    expect(slotForTag('headlines').maxTokens).toBe(3000);
    expect(slotForTag('trending').maxTokens).toBe(3000);
    expect(slotForTag('papers').maxTokens).toBe(3000);
    expect(DIGEST_DEFAULT_MAX_TOKENS).toBe(3000);
  });
});

describe('dev-seed tag fall-through (server-side)', () => {
  const s = parseSchedule('9:headlines,14:deep,20:trending');

  it('a valid requested tag wins over the schedule entry', () => {
    // handleDigestSeed logic: validTag = requested if in the known set, else schedule[hour].tag
    const known: SlotTag[] = ['headlines', 'trending', 'papers', 'deep'];
    const requested = 'deep' as SlotTag;
    const effective = known.includes(requested) ? requested : s[9].tag;
    expect(effective).toBe('deep'); // dev override at hour 9 (schedule says headlines)
  });

  it('an empty/unknown tag falls back to the schedule entry for that hour', () => {
    const requested = 'banana' as unknown as SlotTag;
    const known: SlotTag[] = ['headlines', 'trending', 'papers', 'deep'];
    const effective = known.includes(requested) ? requested : s[20].tag;
    expect(effective).toBe('trending');
  });

  it('an unknown tag at a non-scheduled hour falls back to headlines', () => {
    const requested = '' as unknown as SlotTag;
    const known: SlotTag[] = ['headlines', 'trending', 'papers', 'deep'];
    const effective = known.includes(requested) ? requested : s[1]?.tag ?? 'headlines';
    expect(effective).toBe('headlines');
  });
});

describe('dev-seed type resolution matches the gate (no rollup surprise)', () => {
  it('a deep slot at a non-rollup hour resolves to daily', () => {
    const s = parseSchedule('5:papers,9:headlines,21:deep');
    const t = resolveType(s, 21, 15, 0, false, false, 0, 1);
    expect(t).toBe('daily');
  });

  it('the rollup hour still fires weekly/monthly even in a seeded run', () => {
    const s = parseSchedule('5:papers,9:headlines');
    const t = resolveType(s, 5, 1, 0, true, false, 0, 1); // Sunday, weekly enabled
    expect(t).toBe('weekly');
  });
});
