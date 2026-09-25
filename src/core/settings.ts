/**
 * Runtime settings: a D1-backed override layer over deploy-time env vars.
 *
 * Resolution order (highest wins):
 *   1. D1 `settings` row   — written from the admin panel, no redeploy
 *   2. env var             — deploy-time (wrangler.toml / secret)
 *   3. coded default       — per-def
 *
 * Safety model:
 *  - Only keys in SETTING_DEFS are resolvable; the API rejects everything else,
 *    so the UI and the validator can never disagree.
 *  - Secrets NEVER live here (no BOT_TOKEN/keys) — secrets stay in wrangler
 *    secrets; the panel can only see booleans like the master switches.
 *  - Fail-open: a DB hiccup resolves to env/default values (log a console
 *    warning) so the settings layer can never take the pipeline down.
 */

import type { Env } from './types';

/** One UI-editable setting. `envVar` seeds the fallback value from the
 *  deploy-time environment; `default` applies when the env var is unset. */
export interface SettingDef {
  /** Canonical key — also the D1 row key and the env-var shadow name basis. */
  key: string;
  label: string;
  description: string;
  kind: 'boolean' | 'string' | 'number';
  /** Deploy-time env var that seeds the fallback (e.g. ENABLE_MODERATION). */
  envVar?: string;
  /** Coded default when neither an override nor the env var is present. */
  default: string;
  /** Extra validation beyond kind parsing; returns an error message or null. */
  validate?: (raw: string) => string | null;
  /** UI grouping (panel renders one section per group). */
  group: 'moderation' | 'digest' | 'general';
}

/** The allowlist. Extend per feature; never accept unlisted keys from the API. */
export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'moderation_enabled',
    label: 'Moderation master switch',
    description:
      'When off, group messages pass through unmoderated (each skip is logged). ' +
      'Shadows the ENABLE_MODERATION env var.',
    kind: 'boolean',
    envVar: 'ENABLE_MODERATION',
    default: 'true',
    group: 'moderation',
  },
  {
    key: 'funresponse_enabled',
    label: 'Funny responses',
    description: 'Occasional humorous replies on clean messages. Shadows ENABLE_FUNRESPONSE.',
    kind: 'boolean',
    envVar: 'ENABLE_FUNRESPONSE',
    default: 'false',
    group: 'moderation',
  },
  {
    key: 'selfclean_enabled',
    label: 'Bot message self-clean',
    description:
      'Delete the bot’s own service/quote replies after a while. Shadows ENABLE_SELF_CLEAN.',
    kind: 'boolean',
    envVar: 'ENABLE_SELF_CLEAN',
    default: 'false',
    group: 'moderation',
  },
  {
    key: 'moderation_log_safe',
    label: 'Log safe verdicts',
    description:
      'Off by default: an unflagged message still stands in the group’s own ' +
      'Telegram history, so an audit copy duplicates a standing record — the ' +
      'audit log keeps only flagged rows plus errors. Flip on for a bounded ' +
      'window to harvest clean training pairs via the audit CSV export, then ' +
      'off again. Shadows the MODERATION_LOG_SAFE env var.',
    kind: 'boolean',
    envVar: 'MODERATION_LOG_SAFE',
    default: 'false',
    group: 'moderation',
  },
  {
    key: 'digest_enabled',
    label: 'News digest master switch',
    description:
      'When off, digest cron gates no-op (each tick logs a skip). Shadows ENABLE_NEWS_DIGEST.',
    kind: 'boolean',
    envVar: 'ENABLE_NEWS_DIGEST',
    default: 'false',
    group: 'digest',
  },
  {
    key: 'digest_autopublish',
    label: 'Digest auto-publish',
    description:
      'When off, digest runs are stored as pending drafts for review instead of publishing. Shadows NEWS_AUTO_PUBLISH.',
    kind: 'boolean',
    envVar: 'NEWS_AUTO_PUBLISH',
    default: 'false',
    group: 'digest',
  },
  {
    key: 'digest_fetch_fulltext',
    label: 'Digest full-text extraction',
    description:
      'When on, top digest items fetch + extract page text for richer summaries. Shadows NEWS_FETCH_FULLTEXT.',
    kind: 'boolean',
    envVar: 'NEWS_FETCH_FULLTEXT',
    default: 'false',
    group: 'digest',
  },
  {
    key: 'digest_weekly',
    label: 'Digest weekly rollup',
    description: 'Enables the weekly digest roundup. Shadows NEWS_ENABLE_WEEKLY.',
    kind: 'boolean',
    envVar: 'NEWS_ENABLE_WEEKLY',
    default: 'false',
    group: 'digest',
  },
  {
    key: 'digest_monthly',
    label: 'Digest monthly rollup',
    description: 'Enables the monthly digest deep-dive. Shadows NEWS_ENABLE_MONTHLY.',
    kind: 'boolean',
    envVar: 'NEWS_ENABLE_MONTHLY',
    default: 'false',
    group: 'digest',
  },
  // --- Strong runtime knobs (CSVs/text as text inputs: simple, flexible, and
  // genuinely useful for the list-shaped vars — you can extend them at runtime
  // without a deploy). ---
  {
    key: 'digest_schedule',
    label: 'Digest intraday schedule',
    description:
      'CSV of `hour:tag` slots driving the hourly gate (e.g. "9:headlines,14:papers,20:trending,22:deep"). ' +
      'This is the single source of digest timing; malformed entries are skipped. ' +
      'Shadows NEWS_SCHEDULE.',
    kind: 'string',
    envVar: 'NEWS_SCHEDULE',
    default: '',
    group: 'digest',
  },
  {
    key: 'digest_domain',
    label: 'Digest domain / rotation',
    description:
      'Content subject: a preset (tech, finance, science, health, custom) or a rotation ' +
      'strategy (round-robin / random / all). Unknown values fall back to tech. Shadows NEWS_DOMAIN.',
    kind: 'string',
    envVar: 'NEWS_DOMAIN',
    default: 'tech',
    group: 'digest',
  },
  {
    key: 'digest_topics',
    label: 'Digest topics',
    description:
      'CSV of query phrases the news/scholar engines gather on. Empty = use the domain preset\'s topics. ' +
      'Shadows NEWS_TOPICS.',
    kind: 'string',
    envVar: 'NEWS_TOPICS',
    default: '',
    group: 'digest',
  },
  {
    key: 'digest_language',
    label: 'Digest output language',
    description: 'Language the digest post is written in. Shadows NEWS_LANGUAGE.',
    kind: 'string',
    envVar: 'NEWS_LANGUAGE',
    default: 'English',
    group: 'digest',
  },
  {
    key: 'digest_dialect',
    label: 'Digest output dialect',
    description:
      'Optional dialect of the output language (e.g. "Levantine" for Arabic). Empty = no hint. ' +
      'Shadows NEWS_DIALECT.',
    kind: 'string',
    envVar: 'NEWS_DIALECT',
    default: '',
    group: 'digest',
  },
  {
    key: 'digest_max_items',
    label: 'Digest items per post',
    description: 'How many items the LLM may select (clamped to 1–8 in code). Shadows NEWS_MAX_ITEMS.',
    kind: 'number',
    envVar: 'NEWS_MAX_ITEMS',
    default: '5',
    group: 'digest',
  },
  {
    key: 'digest_min_points',
    label: 'HN quality floor',
    description:
      'Minimum Hacker News points for trending items. Raise during a spammy day to cut junk. ' +
      'Shadows NEWS_MIN_POINTS.',
    kind: 'number',
    envVar: 'NEWS_MIN_POINTS',
    default: '25',
    group: 'digest',
  },
  {
    key: 'digest_deep_body_limit',
    label: 'Digest deep-post body cap',
    description:
      'Max chars kept from a deep-slot post body (other slots cap at 3900). ' +
      'The deep prompt invites ~5000-char posts; lower values truncate them again. ' +
      'Shadows DIGEST_DEEP_BODY_LIMIT.',
    kind: 'number',
    envVar: 'DIGEST_DEEP_BODY_LIMIT',
    default: '7900',
    group: 'digest',
  },
  {
    key: 'digest_sponsor',
    label: 'Digest sponsor footer',
    description:
      'Optional footer line appended post-sanitize (never LLM-generated). Empty = no footer. ' +
      'Plain text or inline Telegram HTML from the post-body allowlist ' +
      '(b/i/u/s/a/code/pre/blockquote; link hrefs must be http(s) or tg), e.g. ' +
      'Brought to you by <a href="https://github.com/srcKod/modflare">Modflare</a>. ' +
      'Markdown [text](url) is not interpreted. Shadows NEWS_SPONSOR_TEXT.',
    kind: 'string',
    envVar: 'NEWS_SPONSOR_TEXT',
    default: '',
    group: 'digest',
  },
  {
    key: 'digest_target_name',
    label: 'Target chat display name',
    description:
      'Human name shown for the target channel/group in confirms and headers. ' +
      'Empty = show the raw chat id. Shadows NEWS_TARGET_CHAT_NAME.',
    kind: 'string',
    envVar: 'NEWS_TARGET_CHAT_NAME',
    default: '',
    group: 'digest',
  },
  {
    key: 'digest_dev_seed',
    label: 'Digest dev-seed endpoint',
    description:
      'Enables the dev-only "run a real draft" panel tool. Intended to stay off in production. ' +
      'Shadows NEWS_DEV_SEED.',
    kind: 'boolean',
    envVar: 'NEWS_DEV_SEED',
    default: 'false',
    group: 'digest',
  },
];

/** Normalized truthy/falsey for boolean settings (env vars may arrive as
 *  unquoted booleans pre-coerced to strings — anything but the false set is
 *  treated as on, matching the codebase's `=== 'true'`... inverted: we fail
 *  OPEN, so only an explicit false disables). */
export function settingBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  const s = v.trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  return fallback;
}

/** Load all D1 overrides in one query. Undefined DB or any error → {} (the
 *  caller falls back to env/defaults; the settings layer never breaks the
 *  pipeline). */
export async function loadSettingOverrides(
  db: D1Database | undefined,
): Promise<Record<string, string>> {
  if (!db) return {};
  try {
    const res = await db
      .prepare('SELECT key, value FROM settings')
      .all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of res.results ?? []) out[r.key] = r.value;
    return out;
  } catch (err) {
    // Fail open: a settings-read failure must never take a feature down.
    console.error(`settings read failed: ${err}`);
    return {};
  }
}

/** Effective value for one key: D1 override → env var → coded default.
 *  Unlisted keys resolve to undefined (the allowlist is the contract). */
export function resolveSetting(
  env: Env,
  overrides: Record<string, string>,
  key: string,
): string | undefined {
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) return undefined;
  if (overrides[key] !== undefined) return overrides[key];
  const envVal = def.envVar
    ? (env as unknown as Record<string, string | undefined>)[def.envVar]
    : undefined;
  if (envVal !== undefined && envVal !== '') return String(envVal);
  return def.default;
}

/** Where a key's effective value came from — the panel shows this per row. */
export function settingSource(
  env: Env,
  overrides: Record<string, string>,
  key: string,
): 'override' | 'env' | 'default' {
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (overrides[key] !== undefined) return 'override';
  if (def?.envVar) {
    const envVal = (env as unknown as Record<string, string | undefined>)[def.envVar];
    if (envVal !== undefined && envVal !== '') return 'env';
  }
  return 'default';
}

/** Kind-aware validation for a raw value. Returns an error message or null. */
export function validateSettingValue(def: SettingDef, raw: string): string | null {
  const v = raw.trim();
  if (def.kind === 'boolean') {
    const s = v.toLowerCase();
    if (!['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'].includes(s)) {
      return 'must be a boolean (true/false)';
    }
  } else if (def.kind === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return 'must be a number';
  } else if (!v) {
    return 'must not be empty';
  }
  return def.validate ? def.validate(v) : null;
}
