import { describe, expect, it } from 'vitest';
import { resolveDigestConfig } from '../../../src/features/digest/config';
import { SETTING_DEFS } from '../../../src/core/settings';
import type { Env } from '../../../src/core/types';

function mkEnv(over: Record<string, string | undefined> = {}): Env {
  return over as unknown as Env;
}

describe('digest settings integration (foundation wiring)', () => {
  it('exposes the digest runtime knobs on the allowlist', () => {
    const keys = SETTING_DEFS.map((d) => d.key);
    for (const k of [
      'digest_enabled',
      'digest_autopublish',
      'digest_fetch_fulltext',
      'digest_weekly',
      'digest_monthly',
    ]) {
      expect(keys).toContain(k);
    }
    // Every digest def maps to a real env var it shadows.
    for (const d of SETTING_DEFS.filter((x) => x.group === 'digest')) {
      expect(d.envVar).toBeTruthy();
    }
  });

  it('a D1 override shadows the env var (auto-publish off despite env on)', () => {
    const cfg = resolveDigestConfig(
      mkEnv({ NEWS_AUTO_PUBLISH: 'true' }),
      undefined,
      { digest_autopublish: 'false' },
    );
    expect(cfg.autoPublish).toBe(false);
  });

  it('no override → env var still applies', () => {
    const cfg = resolveDigestConfig(
      mkEnv({ NEWS_AUTO_PUBLISH: 'true', NEWS_ENABLE_WEEKLY: 'true' }),
    );
    expect(cfg.autoPublish).toBe(true);
    expect(cfg.weeklyEnabled).toBe(true);
  });

  it('a D1 override can turn a digest feature ON even when the env is off', () => {
    const cfg = resolveDigestConfig(
      mkEnv({ NEWS_FETCH_FULLTEXT: 'false', NEWS_ENABLE_MONTHLY: 'false' }),
      undefined,
      { digest_fetch_fulltext: 'true', digest_monthly: 'true' },
    );
    expect(cfg.fetchFulltext).toBe(true);
    expect(cfg.monthlyEnabled).toBe(true);
  });

  it('unlisted override keys are ignored (allowlist is the contract)', () => {
    // A junk key in the overrides map must not crash or leak into the config.
    const cfg = resolveDigestConfig(
      mkEnv({}),
      undefined,
      { not_a_real_key: 'true' },
    );
    // Behavior matches the no-override default (digest off by default).
    expect(cfg.autoPublish).toBe(false);
  });
});
