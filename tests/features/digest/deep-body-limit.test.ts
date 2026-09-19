import { describe, expect, it } from 'vitest';
import { buildPostBody } from '../../../src/features/digest/pipeline';

/** Plain-ASCII body so sanitize escaping, normalizeBreaks and RTL marks are
 *  all no-ops and output length maps 1:1 to input length. */
const plain = (n: number): string => 'a'.repeat(n);

describe('buildPostBody slot-aware sanitize cap', () => {
  it('deep-slot bodies up to 5000 chars survive untruncated (the regression: the old fixed 3900 cap chopped them mid-sentence)', () => {
    expect(buildPostBody(plain(5000), 'deep').length).toBe(5000);
  });

  it('deep cap allows up to 7900 chars and truncates beyond', () => {
    expect(buildPostBody(plain(7900), 'deep').length).toBe(7900);
    expect(buildPostBody(plain(8000), 'deep').length).toBe(7900);
  });

  it('non-deep slots keep the 3900 single-post default', () => {
    expect(buildPostBody(plain(5000), 'headlines').length).toBe(3900);
    expect(buildPostBody(plain(5000), 'trending').length).toBe(3900);
    expect(buildPostBody(plain(5000), 'papers').length).toBe(3900);
    expect(buildPostBody(plain(5000), undefined).length).toBe(3900);
  });

  it('sponsor footer is appended post-sanitize and escaped', () => {
    const out = buildPostBody(plain(5000), 'deep', 'Sponsor & Co');
    const suffix = '\n\n<i>Sponsor &amp; Co</i>';
    expect(out.endsWith(suffix)).toBe(true);
    expect(out.length).toBe(5000 + suffix.length);
  });

  it('no sponsor suffix when sponsorText is empty', () => {
    expect(buildPostBody(plain(100), 'deep', '').length).toBe(100);
    expect(buildPostBody(plain(100), 'deep', null).length).toBe(100);
  });
});
