import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the "store full engine results" feature. The capture and
// insert logic lives inline in runDigestGate (needs full D1+fetch+LLM mocking),
// so instead of exercising the flow we lock the two things that actually break
// at runtime if they drift: the migration that adds the column, and the
// column/bind-count contract of the INSERT in pipeline.ts. A mismatch there is
// a silent 500 on the items insert.

const ROOT = join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('digest_items.extracted_text', () => {
  it('migration 0008 adds the extracted_text column to digest_items', () => {
    const sql = read('migrations/0008_digest_extracted_text.sql');
    expect(sql).toMatch(/ALTER\s+TABLE\s+digest_items/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+extracted_text/i);
    // TEXT, nullable — existing rows must default to NULL, not fail the insert.
    expect(sql).toMatch(/extracted_text\s+TEXT/i);
  });

  it('pipeline INSERT lists exactly 6 columns including extracted_text', () => {
    const src = read('src/features/digest/pipeline.ts');
    const match = src.match(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+digest_items\s*\(([^)]+)\)/i,
    );
    expect(match).not.toBeNull();
    const cols = match![1]
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    expect(cols).toEqual([
      'url_hash',
      'url',
      'title',
      'source',
      'digest_post_id',
      'extracted_text',
    ]);
  });

  it('pipeline binds extractedByUrl.get(it.url) as the 6th value', () => {
    const src = read('src/features/digest/pipeline.ts');
    // The bind call must feed extractedByUrl.get(it.url) ?? null into the
    // extracted_text slot so archived text matches the URL that was extracted.
    expect(src).toMatch(/extractedByUrl\.get\(it\.url\)\s*\?\?\s*null/);
  });

  it('capture populates extractedByUrl only when a snippet exists', () => {
    const src = read('src/features/digest/pipeline.ts');
    // Guard against storing empty strings: the capture is gated on a truthy
    // snippet so rollup / non-fulltext items archive NULL, not ''.
    expect(src).toMatch(/if\s*\(c\.snippet\)\s*extractedByUrl\.set\(c\.url,\s*c\.snippet\)/);
  });
});
