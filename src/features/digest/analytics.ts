/**
 * Digest presentation-time analytics (plan §23.2): sentiment, velocity and
 * trend derived from the insert-only `digest_post_stats` series.
 *
 * Principle: capture everything, classify at presentation — raw per-emoji
 * breakdowns are always stored; the emoji→sentiment mapping
 * (NEWS_REACTION_SIGNALS, merged over defaults in ./config) is applied here,
 * so improving the mapping never requires recapturing data.
 */

import type { ReactionClass } from './config';

/** Latest known reaction snapshot plus its full time series for one post. */
interface StatRow {
  digest_post_id: number;
  value: number | null;
  detail_json: string | null;
  captured_at: string;
}

export interface PostAnalytics {
  /** Total reactions in the latest snapshot (null = never captured). */
  total: number | null;
  /** Latest per-emoji breakdown. */
  breakdown: Record<string, number>;
  /** Weighted positive − negative over the latest breakdown. */
  score: number;
  pos: number;
  neg: number;
  /** Reactions per hour since publish (age-normalized; >1h old only). */
  velocity: number | null;
  /**
   * Direction since the ~24h-earlier snapshot: 'up' | 'flat' | 'down';
   * 'new' when the series is younger than the window (trend not yet
   * meaningful). null when no reactions captured.
   */
  trend: 'up' | 'flat' | 'down' | 'new' | null;
  /** Reaction delta over the trend window (null when trend is 'new'/null). */
  trend_delta: number | null;
}

export const EMPTY_ANALYTICS: PostAnalytics = {
  total: null,
  breakdown: {},
  score: 0,
  pos: 0,
  neg: 0,
  velocity: null,
  trend: null,
  trend_delta: null,
};

const DAY_MS = 24 * 3600 * 1000;
/** Snapshots older than ~a day make the delta meaningless; treat as new. */
const TREND_MIN_AGE_MS = 20 * 3600 * 1000;

/** Derive analytics for one post from its reactions series (ascending). */
export function computeAnalytics(
  series: StatRow[],
  publishedAt: string | null,
  signals: Record<string, ReactionClass>,
  now: number = Date.now(),
): PostAnalytics {
  if (!series.length) return EMPTY_ANALYTICS;
  const latest = series[series.length - 1];
  const total = latest.value ?? 0;
  let breakdown: Record<string, number> = {};
  try {
    breakdown = latest.detail_json
      ? (JSON.parse(latest.detail_json) as Record<string, number>)
      : {};
  } catch {
    breakdown = {};
  }
  let pos = 0;
  let neg = 0;
  for (const [emoji, count] of Object.entries(breakdown)) {
    const cls = signals[emoji];
    if (cls === 'pos') pos += count;
    else if (cls === 'neg') neg += count;
  }

  // Velocity: reactions/hour since publish, floored at 30min to avoid a
  // divide-by-zero spike in the first minutes.
  let velocity: number | null = null;
  if (publishedAt) {
    const ageH = Math.max(0.5, (now - Date.parse(publishedAt)) / 3600_000);
    velocity = Math.round((total / ageH) * 100) / 100;
  }

  // Trend: latest snapshot vs the last one at/before latest − ~24h.
  let trend: PostAnalytics['trend'] = 'new';
  let trendDelta: number | null = null;
  const latestTs = Date.parse(latest.captured_at);
  let baseline: StatRow | null = null;
  for (let i = series.length - 2; i >= 0; i--) {
    const ts = Date.parse(series[i].captured_at);
    if (latestTs - ts >= TREND_MIN_AGE_MS) {
      baseline = series[i];
      break;
    }
  }
  if (baseline) {
    trendDelta = total - (baseline.value ?? 0);
    trend = trendDelta > 0 ? 'up' : trendDelta < 0 ? 'down' : 'flat';
  }

  return {
    total,
    breakdown,
    score: pos - neg,
    pos,
    neg,
    velocity,
    trend,
    trend_delta: trendDelta,
  };
}

/**
 * Load reaction analytics for a set of posts in one query. `publishedAt`
 * maps post id → publication ISO timestamp (velocity needs it).
 */
export async function loadPostAnalytics(
  db: D1Database,
  posts: { id: number; published_at: string | null }[],
  signals: Record<string, ReactionClass>,
): Promise<Map<number, PostAnalytics>> {
  const out = new Map<number, PostAnalytics>();
  if (!posts.length) return out;
  const ids = posts.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT digest_post_id, value, detail_json, captured_at
       FROM digest_post_stats
       WHERE metric = 'reactions' AND digest_post_id IN (${placeholders})
       ORDER BY captured_at ASC`,
    )
    .bind(...ids)
    .all<StatRow>();
  const byPost = new Map<number, StatRow[]>();
  for (const row of res.results ?? []) {
    if (row.digest_post_id == null) continue;
    const list = byPost.get(row.digest_post_id) ?? [];
    list.push(row);
    byPost.set(row.digest_post_id, list);
  }
  for (const p of posts) {
    out.set(
      p.id,
      computeAnalytics(byPost.get(p.id) ?? [], p.published_at, signals),
    );
  }
  return out;
}
