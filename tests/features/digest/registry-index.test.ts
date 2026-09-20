import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Review 1, P2-16: the deep-slot join and the orphaned-items prune both key
// on digest_items.digest_post_id, which had no index (full scans as the
// append-mostly URL registry grows). The migration adds it; the registry
// scan reads newest-first so a future cap drops stale hashes, not arbitrary
// ones.

const ROOT = join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('digest_items post join index', () => {
  it('migration 0009 indexes digest_items.digest_post_id', () => {
    const sql = read('migrations/0009_digest_items_post_index.sql');
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_digest_items_post/i);
    expect(sql).toMatch(/ON\s+digest_items\s*\(\s*digest_post_id\s*\)/i);
  });

  it('the registry scan reads newest-first under its cap', () => {
    const src = read('src/features/digest/pipeline.ts');
    expect(src).toMatch(/SELECT\s+url_hash\s+FROM\s+digest_items\s+ORDER\s+BY\s+id\s+DESC\s+LIMIT/i);
  });
});
