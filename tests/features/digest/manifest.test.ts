import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestFeature } from '../../../src/features/digest/index';
import type { Env } from '../../../src/core/types';

// Review 1, P0-3: pruneDigests existed but no cron claimed it (draft TTL,
// failed/discarded cleanup, stats retention, member snapshot never ran).
// The manifest now owns `0 4 * * *` with a handler running BOTH the digest
// prune and the shared audit prune (claiming the tick without the audit call
// would starve the audit retention).

/** D1 stub recording every prepared statement for post-run assertions. */
function stubDb(seen: string[]) {
  const finish = {
    bind: (..._a: unknown[]) => finish,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { last_row_id: 1, changes: 0 } }),
  };
  return {
    prepare: (sql: string) => {
      seen.push(sql);
      // The orphaned-items lookup sees one doomed post; every other SELECT
      // is empty (settings, last snapshots).
      if (sql.includes('SELECT id FROM digest_posts')) {
        return {
          bind: (..._a: unknown[]) => ({
            first: async () => null,
            all: async () => ({ results: [{ id: 3 }] }),
            run: async () => ({ meta: {} }),
          }),
        };
      }
      return finish;
    },
  } as unknown as D1Database;
}

function routeFor(expr: string) {
  return digestFeature.crons?.find((c) => c.expr === expr)?.handler;
}

describe('digest cron manifest', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('prune must not touch the network');
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('claims the hourly gate and the daily prune ticks', () => {
    const exprs = (digestFeature.crons ?? []).map((c) => c.expr);
    expect(exprs).toContain('0 * * * *');
    expect(exprs).toContain('0 4 * * *');
  });

  it('the 04:00 handler prunes digests AND the audit log', async () => {
    const seen: string[] = [];
    const env = { DB: stubDb(seen) } as unknown as Env;
    const handler = routeFor('0 4 * * *');
    expect(handler).toBeDefined();
    await handler!(env);
    expect(seen.some((s) => s.includes('UPDATE digest_posts'))).toBe(true);
    expect(seen.some((s) => s.includes('DELETE FROM digest_posts'))).toBe(true);
    expect(
      seen.some((s) => s.includes('DELETE FROM digest_post_stats')),
    ).toBe(true);
    expect(seen.some((s) => s.includes('DELETE FROM audit_log'))).toBe(true);
    // Orphaned registry rows of pruned un-published posts go too (P1-9),
    // while published items (dedupe memory) are never touched here.
    const itemsDelete = seen.find((s) => s.includes('DELETE FROM digest_items'));
    expect(itemsDelete).toBeDefined();
    expect(itemsDelete).toContain('published_at IS NULL');
  });
});
