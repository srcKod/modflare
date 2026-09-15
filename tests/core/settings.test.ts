import { describe, expect, it } from 'vitest';
import {
  SETTING_DEFS,
  loadSettingOverrides,
  resolveSetting,
  settingBool,
  settingSource,
  validateSettingValue,
} from '../../src/core/settings';
import type { Env } from '../../src/core/types';

function mkEnv(over: Record<string, string | undefined> = {}): Env {
  return over as unknown as Env;
}

/** Minimal D1 stub for loadSettingOverrides (single full-table SELECT). */
function stubDb(rows: { key: string; value: string }[]) {
  return {
    prepare: () => ({
      bind: (..._args: unknown[]) => ({
        all: async () => ({ results: rows }),
      }),
      all: async () => ({ results: rows }),
    }),
  } as unknown as D1Database;
}

describe('SETTING_DEFS allowlist', () => {
  it('lists the moderation switches with env fallbacks', () => {
    const keys = SETTING_DEFS.map((d) => d.key);
    expect(keys).toContain('moderation_enabled');
    expect(keys).toContain('funresponse_enabled');
    expect(keys).toContain('selfclean_enabled');
    const master = SETTING_DEFS.find((d) => d.key === 'moderation_enabled')!;
    expect(master.envVar).toBe('ENABLE_MODERATION');
    expect(master.default).toBe('true');
    expect(master.kind).toBe('boolean');
  });

  it('rejects unlisted keys in resolution', () => {
    expect(resolveSetting(mkEnv(), {}, 'totally_unlisted')).toBeUndefined();
  });
});

describe('resolveSetting — layering', () => {
  it('override wins over env and default', () => {
    const env = mkEnv({ ENABLE_MODERATION: 'true' });
    expect(resolveSetting(env, { moderation_enabled: 'false' }, 'moderation_enabled')).toBe('false');
  });

  it('env value wins over the coded default when no override', () => {
    const env = mkEnv({ ENABLE_FUNRESPONSE: 'true' });
    expect(resolveSetting(env, {}, 'funresponse_enabled')).toBe('true');
  });

  it('coded default applies when neither layer has a value', () => {
    expect(resolveSetting(mkEnv(), {}, 'moderation_enabled')).toBe('true');
  });

  it('an empty-string env var is treated as unset (falls to default)', () => {
    const env = mkEnv({ ENABLE_MODERATION: '' });
    expect(resolveSetting(env, {}, 'moderation_enabled')).toBe('true');
  });
});

describe('settingSource', () => {
  it('reports override / env / default correctly', () => {
    const env = mkEnv({ ENABLE_FUNRESPONSE: 'true' });
    expect(settingSource(env, { funresponse_enabled: 'false' }, 'funresponse_enabled')).toBe('override');
    expect(settingSource(env, {}, 'funresponse_enabled')).toBe('env');
    expect(settingSource(env, {}, 'moderation_enabled')).toBe('default');
  });
});

describe('settingBool coercion (fail-open)', () => {
  it('explicit false-set disables, everything else on', () => {
    expect(settingBool('false', true)).toBe(false);
    expect(settingBool('0', true)).toBe(false);
    expect(settingBool('OFF', true)).toBe(false);
    expect(settingBool('no', true)).toBe(false);
    expect(settingBool('true', false)).toBe(true);
    expect(settingBool('1', false)).toBe(true);
    expect(settingBool('ON', false)).toBe(true);
  });

  it('empty/undefined/unknown values fall back to the default', () => {
    expect(settingBool('', true)).toBe(true);
    expect(settingBool(undefined, false)).toBe(false);
    expect(settingBool('garbage', true)).toBe(true);
    expect(settingBool('garbage', false)).toBe(false);
  });
});

describe('validateSettingValue', () => {
  it('accepts boolean words for a boolean def', () => {
    const d = SETTING_DEFS.find((x) => x.key === 'moderation_enabled')!;
    expect(validateSettingValue(d, 'true')).toBeNull();
    expect(validateSettingValue(d, 'False')).toBeNull();
    expect(validateSettingValue(d, 'maybe')).not.toBeNull();
  });
});

describe('loadSettingOverrides — fail-open', () => {
  it('returns {} when there is no DB', async () => {
    await expect(loadSettingOverrides(undefined)).resolves.toEqual({});
  });

  it('returns {} when the DB query throws (settings never break the pipeline)', async () => {
    const db = {
      prepare: () => ({ all: async () => { throw new Error('D1 down'); } }),
    } as unknown as D1Database;
    await expect(loadSettingOverrides(db)).resolves.toEqual({});
  });

  it('maps rows into a key→value map', async () => {
    const db = stubDb([{ key: 'moderation_enabled', value: 'false' }]);
    await expect(loadSettingOverrides(db)).resolves.toEqual({
      moderation_enabled: 'false',
    });
  });
});
