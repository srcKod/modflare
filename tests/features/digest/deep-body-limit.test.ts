import { describe, expect, it } from 'vitest';
import { buildPostBody, appendSponsor } from '../../../src/features/digest/pipeline';
import {
  resolveDigestConfig,
  DIGEST_DEEP_BODY_LIMIT,
} from '../../../src/features/digest/config';
import type { Env } from '../../../src/core/types';

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

  it('stored body carries no sponsor — the footer is send-time only', () => {
    expect(buildPostBody(plain(100), 'deep')).not.toContain('<i>');
  });

  it('appendSponsor adds the allowlist-sanitized footer, escaping plain text', () => {
    const out = appendSponsor(plain(5000), 'Sponsor & Co');
    const suffix = '\n\n<i>Sponsor &amp; Co</i>';
    expect(out.endsWith(suffix)).toBe(true);
    expect(out.length).toBe(5000 + suffix.length);
  });

  it('appendSponsor allows a sanitized named link (allowlist, not full escape)', () => {
    const out = appendSponsor(
      plain(100),
      'Brought to you by <a href="https://github.com/srcKod/modflare">Modflare</a>',
    );
    expect(out.endsWith(
      '\n\n<i>Brought to you by <a href="https://github.com/srcKod/modflare">Modflare</a></i>',
    )).toBe(true);
  });

  it('appendSponsor unwraps unknown tags, drops unsafe hrefs, keeps markdown literal', () => {
    const out = appendSponsor(
      plain(100),
      '<script>x</script><a href="javascript:alert(1)">y</a>z [m](https://e.com)',
    );
    expect(out.endsWith('\n\n<i>xyz [m](https://e.com)</i>')).toBe(true);
  });

  it('appendSponsor is idempotent and no-ops on empty', () => {
    const once = appendSponsor(plain(100), 'Sponsor & Co');
    expect(appendSponsor(once, 'Sponsor & Co')).toBe(once);
    expect(appendSponsor(plain(100), '')).toBe(plain(100));
    expect(appendSponsor(plain(100), null)).toBe(plain(100));
  });
});

describe('buildPostBody deepLimit override (cfg.deepBodyLimit)', () => {
  it('uses the passed deepLimit for deep slots (wider and tighter than the default)', () => {
    expect(buildPostBody(plain(10000), 'deep', 10000).length).toBe(10000);
    expect(buildPostBody(plain(5000), 'deep', 3000).length).toBe(3000);
  });

  it('the override never leaks into non-deep slots', () => {
    expect(buildPostBody(plain(5000), 'headlines', 10000).length).toBe(3900);
  });
});

describe('DIGEST_DEEP_BODY_LIMIT / digest_deep_body_limit resolution', () => {
  const resolve = (env: Partial<Env>, overrides?: Record<string, string>) =>
    resolveDigestConfig(env as Env, undefined, overrides ?? {});

  it('defaults to the exported constant when nothing is set', () => {
    expect(resolve({}).deepBodyLimit).toBe(DIGEST_DEEP_BODY_LIMIT);
    expect(resolve({}).deepBodyLimit).toBe(7900);
  });

  it('parses the env var', () => {
    expect(resolve({ DIGEST_DEEP_BODY_LIMIT: '10000' }).deepBodyLimit).toBe(10000);
  });

  it('junk falls back to the default; out-of-range values clamp to 1000-20000', () => {
    expect(resolve({ DIGEST_DEEP_BODY_LIMIT: 'abc' }).deepBodyLimit).toBe(7900);
    expect(resolve({ DIGEST_DEEP_BODY_LIMIT: '30000' }).deepBodyLimit).toBe(20000);
    expect(resolve({ DIGEST_DEEP_BODY_LIMIT: '50' }).deepBodyLimit).toBe(1000);
  });

  it('a panel override shadows the env var', () => {
    expect(
      resolve({ DIGEST_DEEP_BODY_LIMIT: '7900' }, { digest_deep_body_limit: '9000' })
        .deepBodyLimit,
    ).toBe(9000);
  });
});
