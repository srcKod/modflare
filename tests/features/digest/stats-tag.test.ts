import { describe, expect, it } from 'vitest';
import { digestAdminRoutes } from '../../../src/features/digest/admin';
import { slotTagOf } from '../../../src/features/digest/admin';
import type { Env } from '../../../src/core/types';

// Slot-tag filter + column for the Published table: the tag lives in the
// slot-key suffix (`<date>T<hh>:<tag>`), filtered server-side, derived per
// row. Untagged legacy / rollup keys yield a null tag (dash cell).

const ROWS = [
  {
    id: 1, title: 'H', type: 'daily', domain: 'tech',
    published_at: '2026-09-16T06:00:00.000Z', message_id: 138,
    target_chat_id: '-1001', edited_at: null, body: 'x',
    slot_key: '2026-09-16T09:headlines',
  },
  {
    id: 2, title: 'D', type: 'daily', domain: 'tech',
    published_at: '2026-09-16T18:00:00.000Z', message_id: 142,
    target_chat_id: '-1001', edited_at: null, body: 'x',
    slot_key: '2026-09-16T21:deep',
  },
  {
    id: 3, title: 'Old', type: 'daily', domain: 'tech',
    published_at: '2026-09-13T06:00:00.000Z', message_id: 100,
    target_chat_id: '-1001', edited_at: null, body: 'x',
    slot_key: '2026-09-13T09',
  },
];

function stubDb() {
  const stmtFor = (sql: string) => {
    // The tag filter is a SQL LIKE on the slot-key suffix — honor it like D1
    // would: only rows whose key ends with `:<tag>` match.
    const tagMatch = /LIKE '%' \|\| ':' \|\| \?/.test(sql);
    return {
      bind: (...args: unknown[]) => ({
        first: async () => null,
        all: async () => ({
          results: tagMatch
            ? ROWS.filter((r) => args.length && r.slot_key.endsWith(`:${args[0]}`))
            : ROWS,
        }),
        run: async () => ({ meta: {} }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: {} }),
    };
  };
  return {
    prepare: (sql: string) => stmtFor(sql),
  } as unknown as D1Database;
}

async function getStats(tag?: string) {
  const route = digestAdminRoutes.find(
    (r) => r.method === 'GET' && r.rest === '/api/digest/stats',
  )!;
  const url = 'http://localhost/admin/api/digest/stats' + (tag ? `?tag=${tag}` : '');
  const res = await route.handler(new Request(url), { DB: stubDb() } as unknown as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    posts: { id: number; tag: string | null }[];
    total: number;
  };
}

describe('digest stats slot-tag filter', () => {
  it('derives the tag per row, null for untagged keys', async () => {
    const d = await getStats();
    expect(d.total).toBe(3);
    expect(d.posts.map((p) => [p.id, p.tag])).toEqual([
      [1, 'headlines'],
      [2, 'deep'],
      [3, null],
    ]);
  });

  it('filters server-side by tag', async () => {
    const d = await getStats('deep');
    expect(d.total).toBe(1);
    expect(d.posts[0]).toMatchObject({ id: 2, tag: 'deep' });
  });

  it('slotTagOf maps keys, rollups and junk to null', () => {
    expect(slotTagOf('2026-09-16T09:headlines')).toBe('headlines');
    expect(slotTagOf('2026-09-16T21:deep')).toBe('deep');
    expect(slotTagOf('2026-09-13T09')).toBeNull();
    expect(slotTagOf('weekly-2026-W37')).toBeNull();
    expect(slotTagOf('2026-09-16T09:bogus')).toBeNull();
    expect(slotTagOf(null)).toBeNull();
  });
});
