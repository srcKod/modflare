import { describe, expect, it } from 'vitest';
import {
  computeAnalytics,
  EMPTY_ANALYTICS,
} from '../../../src/features/digest/analytics';
import { parseReactionSignals } from '../../../src/features/digest/config';

const signals = parseReactionSignals(undefined);
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('computeAnalytics', () => {
  it('returns empty analytics for no snapshots', () => {
    expect(computeAnalytics([], null, signals)).toEqual(EMPTY_ANALYTICS);
  });

  it('scores sentiment from the latest breakdown (pos − neg)', () => {
    const series = [
      {
        digest_post_id: 1,
        value: 5,
        detail_json: JSON.stringify({ '\u{1F44D}': 3, '\u{1F44E}': 1, '\u{1F62E}': 1 }),
        captured_at: iso(1000),
      },
    ];
    const a = computeAnalytics(series, null, signals);
    expect(a.total).toBe(5);
    expect(a.pos).toBe(3);
    expect(a.neg).toBe(1);
    expect(a.score).toBe(2); // 😮 neutral ignored
  });

  it('computes age-normalized velocity from publish time', () => {
    const now = 1_700_000_000_000;
    const series = [
      {
        digest_post_id: 1,
        value: 12,
        detail_json: '{}',
        captured_at: iso(now),
      },
    ];
    const a = computeAnalytics(series, iso(now - 6 * 3600_000), signals, now);
    expect(a.velocity).toBe(2); // 12 over 6h
  });

  it('floors velocity at 30min so a fresh post does not spike', () => {
    const now = 1_700_000_000_000;
    const series = [
      { digest_post_id: 1, value: 3, detail_json: '{}', captured_at: iso(now) },
    ];
    const a = computeAnalytics(series, iso(now - 5 * 60_000), signals, now);
    expect(a.velocity).toBe(6); // 3 over the 0.5h floor, not 36
  });

  it('marks a single-snapshot post as new trend', () => {
    const series = [
      { digest_post_id: 1, value: 4, detail_json: '{}', captured_at: iso(1000) },
    ];
    const a = computeAnalytics(series, iso(1000), signals);
    expect(a.trend).toBe('new');
    expect(a.trend_delta).toBeNull();
  });

  it('derives up/down/flat from the ~24h baseline delta', () => {
    const t = 1_700_000_000_000;
    const up = computeAnalytics(
      [
        { digest_post_id: 1, value: 2, detail_json: '{}', captured_at: iso(t - DAY) },
        { digest_post_id: 1, value: 7, detail_json: '{}', captured_at: iso(t) },
      ],
      iso(t - DAY),
      signals,
      t,
    );
    expect(up.trend).toBe('up');
    expect(up.trend_delta).toBe(5);

    const flat = computeAnalytics(
      [
        { digest_post_id: 1, value: 7, detail_json: '{}', captured_at: iso(t - DAY) },
        { digest_post_id: 1, value: 7, detail_json: '{}', captured_at: iso(t) },
      ],
      iso(t - DAY),
      signals,
      t,
    );
    expect(flat.trend).toBe('flat');
    expect(flat.trend_delta).toBe(0);

    const down = computeAnalytics(
      [
        { digest_post_id: 1, value: 9, detail_json: '{}', captured_at: iso(t - DAY) },
        { digest_post_id: 1, value: 3, detail_json: '{}', captured_at: iso(t) },
      ],
      iso(t - DAY),
      signals,
      t,
    );
    expect(down.trend).toBe('down');
    expect(down.trend_delta).toBe(-6);
  });

  it('ignores a same-day intermediate snapshot when picking the baseline', () => {
    const t = 1_700_000_000_000;
    // Two snapshots 3h apart, both < 20h before the latest → no valid baseline.
    const a = computeAnalytics(
      [
        { digest_post_id: 1, value: 1, detail_json: '{}', captured_at: iso(t - 6 * 3600_000) },
        { digest_post_id: 1, value: 2, detail_json: '{}', captured_at: iso(t - 3 * 3600_000) },
        { digest_post_id: 1, value: 4, detail_json: '{}', captured_at: iso(t) },
      ],
      iso(t),
      signals,
      t,
    );
    expect(a.trend).toBe('new');
  });

  it('tolerates malformed detail_json (empty breakdown)', () => {
    const series = [
      { digest_post_id: 1, value: 2, detail_json: 'not json', captured_at: iso(1) },
    ];
    const a = computeAnalytics(series, null, signals);
    expect(a.total).toBe(2);
    expect(a.breakdown).toEqual({});
    expect(a.score).toBe(0);
  });
});
