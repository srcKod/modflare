/**
 * Admin API for the runtime-settings foundation. Mounted alongside the
 * feature manifests' routes (settings are cross-feature, so they live in
 * core, not in any one feature's manifest).
 *
 *   GET  /api/settings          → defs + effective values + source layer
 *   POST /api/settings          → {key, value} validate + upsert + audit
 *   POST /api/settings/reset    → {key} delete override (revert to env/default)
 *
 * All writes are CSRF-checked and audited to the D1 audit log (who/old→new).
 */

import type { AdminRoute } from './router';
import type { Env } from './types';
import { json, csrfOk } from './admin';
import { makeLogger } from './logger';
import {
  SETTING_DEFS,
  loadSettingOverrides,
  resolveSetting,
  settingSource,
  validateSettingValue,
} from './settings';

/** GET /api/settings — the panel form is generated from this. */
async function handleGetSettings(_request: Request, env: Env): Promise<Response> {
  const overrides = await loadSettingOverrides(env.DB);
  const envRec = env as unknown as Record<string, string | undefined>;
  return json({
    defs: SETTING_DEFS.map((d) => ({
      key: d.key,
      label: d.label,
      description: d.description,
      kind: d.kind,
      group: d.group,
    })),
    values: SETTING_DEFS.map((d) => {
      const effective = resolveSetting(env, overrides, d.key);
      return {
        key: d.key,
        value: effective ?? '',
        source: settingSource(env, overrides, d.key),
        // For booleans send the canonical true/false for the checkbox state.
        envValue:
          d.envVar && envRec[d.envVar] !== undefined && envRec[d.envVar] !== ''
            ? String(envRec[d.envVar])
            : null,
      };
    }),
  });
}

/** POST /api/settings — validate against the allowlist, upsert, audit. */
async function handleSaveSetting(request: Request, env: Env): Promise<Response> {
  if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);

  const body = (await request.json().catch(() => null)) as {
    key?: unknown;
    value?: unknown;
  } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  const rawValue = typeof body?.value === 'string' ? body.value : String(body?.value ?? '');

  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) return json({ error: 'Unknown setting key' }, 400);
  const invalid = validateSettingValue(def, rawValue);
  if (invalid) return json({ error: `Invalid value: ${invalid}` }, 400);

  // Canonical storage form: booleans as true/false, everything trimmed.
  const value =
    def.kind === 'boolean' ? (['true', '1', 'on', 'yes'].includes(rawValue.trim().toLowerCase()) ? 'true' : 'false') : rawValue.trim();

  const overrides = await loadSettingOverrides(env.DB);
  const old = resolveSetting(env, overrides, key) ?? '';

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, value, now, 'admin-panel')
    .run();

  // Audit the change (who/old→new) so the existing panel viewer shows it.
  await makeLogger(env).warn('setting_changed', {
    reason: `${key}: ${old} → ${value}`,
    extra: { key, old, new: value, source: 'admin-panel' },
  });

  return json({ ok: true, key, value, previous: old });
}

/** POST /api/settings/reset — delete the override; the env/default value wins again. */
async function handleResetSetting(request: Request, env: Env): Promise<Response> {
  if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);

  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) return json({ error: 'Unknown setting key' }, 400);

  const overrides = await loadSettingOverrides(env.DB);
  const old = overrides[key];
  if (old === undefined) return json({ ok: true, key, reverted: false });

  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

  await makeLogger(env).warn('setting_reset', {
    reason: `${key}: ${old} → (env/default)`,
    extra: { key, old, source: 'admin-panel' },
  });

  return json({ ok: true, key, reverted: true });
}

/** Settings' contribution to the admin panel API (cross-feature, core-level). */
export const settingsAdminRoutes: AdminRoute[] = [
  { method: 'GET', rest: '/api/settings', handler: handleGetSettings },
  { method: 'POST', rest: '/api/settings', handler: handleSaveSetting },
  { method: 'POST', rest: '/api/settings/reset', handler: handleResetSetting },
];
