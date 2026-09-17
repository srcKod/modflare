import { describe, expect, it } from 'vitest';
import { resolveDigestConfig, effectiveSchedule } from '../../../src/features/digest/config';
import { digestAdminRoutes } from '../../../src/features/digest/admin';
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

  it('digest strong knobs shadow env vars (domain, topics, language, dialect)', () => {
    const cfg = resolveDigestConfig(
      mkEnv({
        NEWS_DOMAIN: 'tech',
        NEWS_TOPICS: 'weather, sports',
        NEWS_LANGUAGE: 'English',
        NEWS_DIALECT: undefined,
        NEWS_MAX_ITEMS: '5',
        NEWS_MIN_POINTS: '25',
      }),
      undefined,
      {
        digest_domain: 'finance',
        digest_topics: 'AI agents, robotics',
        digest_language: 'Arabic',
        digest_dialect: 'Levantine',
        digest_max_items: '8',
        digest_min_points: '40',
      },
    );
    expect(cfg.domain).toBe('finance');
    // Topics split on commas only — multi-word phrases survive intact.
    expect(cfg.topics).toEqual(['AI agents', 'robotics']);
    expect(cfg.language).toBe('Arabic');
    expect(cfg.dialect).toBe('Levantine');
    expect(cfg.maxItems).toBe(8);
    expect(cfg.minPoints).toBe(40);
  });

  it('a D1 topics override wins even when the env var has topics', () => {
    const cfg = resolveDigestConfig(
      mkEnv({ NEWS_TOPICS: 'env-topic' }),
      undefined,
      { digest_topics: 'override-topic' },
    );
    expect(cfg.topics).toEqual(['override-topic']);
  });

  it('empty-string overrides fall back to the env var', () => {
    // A blank text input in the panel must not silently wipe the env value.
    const cfg = resolveDigestConfig(
      mkEnv({ NEWS_LANGUAGE: 'English' }),
      undefined,
      { digest_language: '' },
    );
    expect(cfg.language).toBe('English');
  });

  it('empty topics override means "use the preset topics" (not empty)', () => {
    const cfg = resolveDigestConfig(
      mkEnv({}),
      undefined,
      { digest_topics: '' },
    );
    // No env topics, empty override → the tech preset's topics.
    expect(cfg.topics.length).toBeGreaterThan(0);
    expect(cfg.topics).not.toEqual([]);
  });

  it('sponsor text override works and empty falls back to env', () => {
    const withOverride = resolveDigestConfig(mkEnv({}), undefined, {
      digest_sponsor: 'Brought to you by Example',
    });
    expect(withOverride.sponsorText).toBe('Brought to you by Example');

    const fallback = resolveDigestConfig(
      mkEnv({ NEWS_SPONSOR_TEXT: 'env-sponsor' }),
      undefined,
      { digest_sponsor: '' },
    );
    expect(fallback.sponsorText).toBe('env-sponsor');
  });
});

describe('effectiveSchedule (schedule override → env fallback)', () => {
  it('an override beats the env var', () => {
    const v = effectiveSchedule(
      mkEnv({ NEWS_SCHEDULE: '9:headlines' }),
      { digest_schedule: '5:papers,7:trending' },
    );
    expect(v).toBe('5:papers,7:trending');
  });

  it('no override → the env var is used', () => {
    expect(
      effectiveSchedule(mkEnv({ NEWS_SCHEDULE: '9:headlines' }), {}),
    ).toBe('9:headlines');
  });

  it('a blank override falls back to the env var (you can\'t clear via blank)', () => {
    expect(
      effectiveSchedule(mkEnv({ NEWS_SCHEDULE: '9:headlines' }), {
        digest_schedule: '   ',
      }),
    ).toBe('9:headlines');
  });
});

describe('digest settings view (panel)', () => {
  // The panel renders worker-UTC timestamps in the display timezone, served
  // here (review 1, P2-20b). No DB needed — all env/default resolution.
  async function settingsView(env: Env) {
    const route = digestAdminRoutes.find(
      (r) => r.method === 'GET' && r.rest === '/api/digest/settings',
    )!;
    const res = await route.handler(
      new Request('http://localhost/admin/api/digest/settings'),
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { timezone: string };
  }

  it('exposes the configured timezone', async () => {
    const body = await settingsView(mkEnv({ TIMEZONE: 'Asia/Baghdad' }));
    expect(body.timezone).toBe('Asia/Baghdad');
  });

  it('defaults to UTC when unset', async () => {
    const body = await settingsView(mkEnv({}));
    expect(body.timezone).toBe('UTC');
  });
});
