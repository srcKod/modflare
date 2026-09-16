/**
 * Digest configuration: content-domain presets and env resolution.
 * Precedence: explicit env var > preset value > built-in default.
 */

import { envList } from '../../core/config';

export type DigestMode = 'news' | 'papers' | 'both';
export type DigestContentType = 'daily' | 'weekly' | 'monthly';
import type { Env } from '../../core/types';
import type { CandidateTag, DigestCandidate } from '../../shared/sources';

interface DomainPreset {
  topics: string[];
  newsEngines: string[];
  scholarEngines: string[];
  arxivCats: string[];
  includeDomains: string[];
  gnewsLocale: string; // hl/gl/ceid params for news.google.com
  rssFeeds: string[];
}

export const DOMAIN_PRESETS: Record<string, DomainPreset> = {
  // `tech` spans western + Chinese sources: gnews is queried in BOTH the en-US
  // and zh-CN locales (see engineGnews), the Chinese outlets below come in
  // through `rss`, and cs.RO is added to cover the robotics surge. cs.CL keeps
  // the language-model angle that 大模型 maps to.
  tech: {
    topics: [
      'artificial intelligence',
      'AI agents',
      'developer tools',
      'cloud computing',
      'cybersecurity',
      'robotics',
      '人工智能',
      '大模型',
      '机器人',
    ],
    newsEngines: ['gnews', 'hn'],
    scholarEngines: ['arxiv', 'hf', 's2'],
    arxivCats: ['cs.AI', 'cs.CL', 'cs.LG', 'cs.RO'],
    includeDomains: [],
    // Comma-separated — engineGnews runs one fetch per locale and merges.
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en,hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    rssFeeds: [
      'https://www.qbitai.com/feed',
      'https://www.scmp.com/rss/91/feed',
      'https://technode.com/feed/',
    ],
  },
  finance: {
    topics: ['central banks', 'stock markets', 'fintech', 'crypto regulation'],
    newsEngines: ['gnews'],
    scholarEngines: [],
    // Quantitative-finance categories so a papers slot under a rotation-picked
    // finance day keeps its arXiv source (empty cats = engine no-ops).
    arxivCats: ['q-fin.CP', 'q-fin.ST', 'q-fin.TR', 'q-fin.RM'],
    includeDomains: [],
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
    rssFeeds: ['https://feeds.a.dj.com/rss/RSSMarketsMain.xml'],
  },
  science: {
    topics: ['space exploration', 'physics', 'genomics', 'climate science'],
    newsEngines: ['gnews'],
    scholarEngines: ['arxiv'],
    arxivCats: ['physics.space-ph', 'q-bio.GN'],
    includeDomains: [],
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
    rssFeeds: ['https://phys.org/rss-feed/'],
  },
  health: {
    topics: ['public health', 'epidemiology', 'medical research'],
    newsEngines: ['gnews'],
    scholarEngines: [],
    // Epidemiology / quantitative-methods categories — see finance note above.
    arxivCats: ['q-bio.PE', 'q-bio.QM'],
    includeDomains: [],
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
    rssFeeds: [],
  },
  custom: {
    topics: [], // must come from NEWS_TOPICS
    newsEngines: ['gnews'],
    scholarEngines: [],
    arxivCats: [],
    includeDomains: [],
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
    rssFeeds: [],
  },
};

/* ------------------------------------------------------------------ */
/* Multi-domain rotation (plan §23.1)                                  */
/* ------------------------------------------------------------------ */

/** Rotation strategies accepted by NEWS_DOMAIN (alias: 'all' = round-robin). */
const ROTATION_STRATEGIES = ['round-robin', 'random', 'all'];
/** Presets eligible for rotation — everything except `custom`, which needs
 * explicit NEWS_TOPICS and is never picked automatically. */
export const ROTATION_PRESETS = Object.keys(DOMAIN_PRESETS).filter(
  (d) => d !== 'custom',
);

/** True when NEWS_DOMAIN holds a rotation strategy rather than a preset. */
export function isRotationDomain(value: string): boolean {
  return ROTATION_STRATEGIES.includes((value || '').trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Intraday schedule (plan §23.6)                                      */
/* ------------------------------------------------------------------ */

/** Content type of an intraday slot — a CandidateTag the slot gathers for.
 *  `deep` is the exception: it gathers nothing (D1-sourced deep-dive over
 *  today's already-published items). */
export type SlotTag = 'headlines' | 'trending' | 'papers' | 'deep';

/** A single intraday slot: the engines + LLM mode + token budget it runs. */
export interface SlotConfig {
  tag: SlotTag;
  mode: DigestMode;
  /** Engines to gather from for this slot (already split news/scholar). */
  newsEngines: string[];
  scholarEngines: string[];
  /**
   * Topics this slot gathers on. Omitted → inherit the resolved preset topics
   * (correct for `headlines`, which is keyword-targeted). An explicit [] forces
   * a topic-agnostic, match-all gather — required for `trending`, because HN's
   * Algolia does full-text TITLE matching and generic topic phrases ("artificial
   * intelligence") never appear verbatim in HN titles, so any topic filter makes
   * the query return nothing and the slot silently skips.
   */
  topics?: string[];
  /**
   * Per-slot LLM output budget (replaces the removed global DIGEST_MAX_TOKENS
   * env). Overrides cfg.llm.maxTokens for this run only.
   */
  maxTokens: number;
}

/**
 * Parse NEWS_SCHEDULE (CSV of `hour:tag`) into hour → SlotConfig.
 *   e.g. "9:headlines,14:papers,20:trending,22:deep"
 * Hours are local (TIMEZONE). Unknown tags are skipped. `segment` is reserved
 * and not schedulable yet. Deep slots belong AFTER the headlines hour — they
 * analyze today's already-published items.
 */
export function parseSchedule(raw: string | undefined): Record<number, SlotConfig> {
  const out: Record<number, SlotConfig> = {};
  for (const part of envList(raw)) {
    // `hour:tag` is a single token (envList splits on whitespace, so the colon
    // must stay glued to its hour and tag — "9:headlines", never "9 : headlines").
    const m = /^(\d{1,2}):(\w+)$/.exec(part);
    if (!m) continue;
    const hour = Number(m[1]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const tag = m[2] as SlotTag;
    if (tag !== 'headlines' && tag !== 'trending' && tag !== 'papers' && tag !== 'deep') continue;
    out[hour] = slotForTag(tag);
  }
  return out;
}

/** The earliest scheduled hour — when weekly/monthly rollups fire. Derived from
 *  the schedule ("morning roundup") instead of the removed NEWS_PUBLISH_HOURS. */
export function rollupHourFromSchedule(
  schedule: Record<number, SlotConfig>,
): number | null {
  const hours = Object.keys(schedule).map(Number);
  return hours.length ? Math.min(...hours) : null;
}

/** The engine set + mode + token budget for a given slot tag. Paid/credit
 *  engines (tavily/exa/jsearch) gate on their key inside the engine fns, so
 *  listing them is safe even when unset — they simply no-op. */
export function slotForTag(tag: SlotTag): SlotConfig {
  switch (tag) {
    case 'papers':
      return { tag, mode: 'papers', newsEngines: [], scholarEngines: ['arxiv', 'hf', 's2'], maxTokens: 3000 };
    case 'trending':
      // Topic-agnostic: trending surfaces what's hot, not what matches keywords.
      // See SlotConfig.topics — an empty Algolia `query=` matches all stories.
      return { tag, mode: 'news', newsEngines: ['hn'], scholarEngines: [], topics: [], maxTokens: 3000 };
    case 'deep':
      // Gathers NOTHING — the pipeline loads today's published items (with
      // archived extracted_text) from D1 and asks for an analytical deep-dive.
      // Costs zero subrequests; the budget goes to richer LLM output.
      return { tag, mode: 'news', newsEngines: [], scholarEngines: [], maxTokens: 5000 };
    case 'headlines':
    default:
      return {
        tag,
        mode: 'news',
        newsEngines: ['gnews', 'hn', 'rss', 'tavily', 'exa', 'jsearch'],
        scholarEngines: [],
        maxTokens: 3000,
      };
  }
}

/** True when NEWS_SCHEDULE declares at least one slot. */
export function hasSchedule(env: Pick<Env, 'NEWS_SCHEDULE'>): boolean {
  return Object.keys(parseSchedule(env.NEWS_SCHEDULE)).length > 0;
}

/* ------------------------------------------------------------------ */
/* Reaction sentiment mapping (plan §23.2)                             */
/* ------------------------------------------------------------------ */

export type ReactionClass = 'pos' | 'neg';

/** Built-in sentiment classes; everything else is neutral. Config adds to
 * (or overrides) these — never replaces, so a typo doesn't lose the basics. */
const DEFAULT_REACTION_SIGNALS: Record<string, ReactionClass> = {
  '\u{1F44D}': 'pos', // 👍
  '\u{2764}\u{FE0F}': 'pos', // ❤️
  '\u{1F525}': 'pos', // 🔥
  '\u{1F389}': 'pos', // 🎉
  '\u{1F44F}': 'pos', // 👏
  '\u{2764}': 'pos', // ❤ (without variation selector)
  '\u{1F44E}': 'neg', // 👎
};

/**
 * Parse NEWS_REACTION_SIGNALS: comma-separated `emoji:class` pairs
 * (class = 'pos' | 'neg'; any other class on a pair is ignored). Merged
 * over the defaults. Unmapped emojis stay neutral (capture-all principle:
 * raw breakdown is always stored; classification is presentation-time).
 */
export function parseReactionSignals(
  raw: string | undefined,
): Record<string, ReactionClass> {
  const map: Record<string, ReactionClass> = { ...DEFAULT_REACTION_SIGNALS };
  for (const part of envList(raw)) {
    const i = part.lastIndexOf(':');
    if (i <= 0) continue;
    const emoji = part.slice(0, i).trim();
    const cls = part.slice(i + 1).trim().toLowerCase();
    if (!emoji) continue;
    if (cls === 'pos' || cls === 'neg') map[emoji] = cls;
    else if (cls === 'neutral' || cls === 'neu') delete map[emoji];
  }
  return map;
}

/** Resolved rotation: strategy + the preset list it cycles/picks from. */
export interface DigestRotation {
  strategy: 'round-robin' | 'random';
  presets: string[];
}

export interface DigestConfig {
  /** Configured NEWS_DOMAIN value (preset name or rotation strategy). */
  domain: string;
  /** Rotation when NEWS_DOMAIN is a strategy value; null for fixed presets. */
  rotation: DigestRotation | null;
  /** Domain that produced this config (fixed preset, or the rotation pick). */
  effectiveDomain: string;
  mode: DigestMode;
  topics: string[];
  newsEngines: string[];
  scholarEngines: string[];
  arxivCats: string[];
  includeDomains: string[];
  minPoints: number;
  maxItems: number;
  fetchFulltext: boolean;
  /** Cost guard: max candidates enriched with full-text per run. */
  extractMax: number;
  targetChatId: string;
  weeklyEnabled: boolean;
  weeklyDay: number; // 0=Sunday
  monthlyEnabled: boolean;
  monthlyDay: number; // 1..28
  language: string;
  dialect?: string;
  autoPublish: boolean;
  draftTtlDays: number;
  sponsorText?: string;
  postAnalytics: boolean;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    extraBody?: string;
    jsonMode: boolean;
  };
  tavilyKey?: string;
  exaKey?: string;
  jinaKey?: string;
  llamaKey?: string;
  gnewsLocale: string;
  rssFeeds: string[];
}

/** Digest LLM output budget when no per-slot override applies (rollups,
 *  env-less default — the old global DIGEST_MAX_TOKENS env was removed as too
 *  generic; slots carry explicit budgets via SlotConfig.maxTokens). */
export const DIGEST_DEFAULT_MAX_TOKENS = 3000;


export function resolveDigestConfig(
  env: Env,
  /** Rotation pick — overrides NEWS_DOMAIN when it holds a strategy value. */
  effectiveDomain?: string,
  /** D1 settings overrides (runtime) — shadow the env vars per SETTING_DEFS.
   *  Omitted (undefined) = pure env/deploy-time resolution, as before. */
  overrides?: Record<string, string>,
): DigestConfig {
  // Runtime settings layer: a D1 override beats the env var it shadows.
  // `ov` returns the effective raw value for a key (override → env → unset).
  const ov = (key: string, envVar: string): string | undefined =>
    overrides?.[key] ?? (env as unknown as Record<string, string | undefined>)[envVar];

  const configured = (env.NEWS_DOMAIN || 'tech').trim();
  const lower = configured.toLowerCase();
  // Rotation values share the preset slot: strategy lives in the value, the
  // domain is decided per-run in the pipeline (needs D1 for the cursor).
  const rotation: DigestRotation | null = isRotationDomain(configured)
    ? {
        strategy: lower === 'random' ? 'random' : 'round-robin',
        presets: ROTATION_PRESETS,
      }
    : null;
  const domain = effectiveDomain ?? (rotation ? 'tech' : configured);
  const preset = DOMAIN_PRESETS[domain] ?? DOMAIN_PRESETS.tech;
  const modeRaw = (env.NEWS_MODE || 'news').trim() as DigestMode;
  const mode: DigestMode = ['news', 'papers', 'both'].includes(modeRaw)
    ? modeRaw
    : 'news';

  const topics = envList(env.NEWS_TOPICS).length
    ? envList(env.NEWS_TOPICS)
    : preset.topics;
  let engines = envList(env.NEWS_ENGINE).length
    ? envList(env.NEWS_ENGINE)
    : [...preset.newsEngines];
  if (mode === 'papers') engines = [...preset.scholarEngines, ...engines];

  return {
    domain: configured,
    rotation,
    effectiveDomain: domain,
    mode,
    topics,
    newsEngines: engines,
    scholarEngines: preset.scholarEngines,
    arxivCats: envList(env.NEWS_ARXIV_CATEGORIES).length
      ? envList(env.NEWS_ARXIV_CATEGORIES)
      : preset.arxivCats,
    includeDomains: envList(env.NEWS_INCLUDE_DOMAINS).length
      ? envList(env.NEWS_INCLUDE_DOMAINS)
      : preset.includeDomains,
    minPoints: Number(env.NEWS_MIN_POINTS) || 25,
    maxItems: Math.min(8, Math.max(1, Number(env.NEWS_MAX_ITEMS) || 5)),
    fetchFulltext: (ov('digest_fetch_fulltext', 'NEWS_FETCH_FULLTEXT') || '').trim() === 'true',
    extractMax: Math.max(1, Math.min(12, Number(env.NEWS_EXTRACT_MAX_PER_RUN) || 4)),
    targetChatId: (env.NEWS_TARGET_CHAT_ID || '').trim(),
    weeklyEnabled: (ov('digest_weekly', 'NEWS_ENABLE_WEEKLY') || '') === 'true',
    weeklyDay: Number(env.NEWS_WEEKLY_DAY ?? 0) || 0,
    monthlyEnabled: (ov('digest_monthly', 'NEWS_ENABLE_MONTHLY') || '') === 'true',
    monthlyDay: Number(env.NEWS_MONTHLY_DAY ?? 1) || 1,
    language: env.NEWS_LANGUAGE?.trim() || 'English',
    dialect: env.NEWS_DIALECT?.trim() || undefined,
    autoPublish: (ov('digest_autopublish', 'NEWS_AUTO_PUBLISH') || '').trim().toLowerCase() === 'true',
    draftTtlDays: Number(env.NEWS_DRAFT_TTL_DAYS) || 7,
    sponsorText: env.NEWS_SPONSOR_TEXT?.trim() || undefined,
    postAnalytics: (env.ENABLE_POST_ANALYTICS || '').trim() === 'true',
    llm: {
      baseUrl: (env.DIGEST_BASE_URL || env.OPENAI_BASE_URL || '').replace(
        /\/+$/,
        '',
      ),
      apiKey: env.DIGEST_API_KEY || env.OPENAI_API_KEY || '',
      model: env.DIGEST_MODEL || env.TEXT_MODEL || env.MODEL_NAME,
      maxTokens: DIGEST_DEFAULT_MAX_TOKENS,
      timeoutMs: Number(env.DIGEST_TIMEOUT_MS) || 120_000,
      extraBody: env.DIGEST_EXTRA_BODY_JSON || env.LLM_EXTRA_BODY_JSON,
      jsonMode: (env.DIGEST_RESPONSE_FORMAT ?? 'json') === 'json',
    },
    tavilyKey: env.TAVILY_API_KEY,
    exaKey: env.EXA_API_KEY,
    jinaKey: env.JINA_API_KEY,
    llamaKey: env.LLAMAINDEX_APIKEY,
    gnewsLocale: preset.gnewsLocale,
    rssFeeds: envList(env.NEWS_RSS_FEEDS).length
      ? envList(env.NEWS_RSS_FEEDS)
      : preset.rssFeeds,
  };
}

/**
 * Is the dev seed toggle on? Coerces to string because the var may arrive as
 * either a quoted string ("true") or an unquoted boolean (true) depending on
 * how it was set in wrangler.toml — calling `.trim()` on the raw boolean
 * throws, which is exactly the 500 the unquoted form produced.
 */
export function isSeedEnabled(seed: string | boolean | undefined): boolean {
  return String(seed || '').trim().toLowerCase() === 'true';
}

/**
 * Parsed intent of a `/api/digest/drafts...` path (relative to the panel base).
 * Pure + exported so the digit-matching regexes are unit-tested. These *must* be
 * regex literals: a previous `new RegExp('...(\\d+)...')` collapsed `\d` to a
 * literal `d` and silently 404'd every numeric draft id.
 */
export type DraftsIntent =
  | { kind: 'list' }
  | { kind: 'one'; id: number }
  | { kind: 'action'; id: number; action: 'save' | 'publish' | 'discard' }
  | { kind: 'unknown'; rest: string };

const ACTION_RE = /^\/api\/digest\/drafts\/(\d+)\/(save|publish|discard)$/;
const ONE_RE = /^\/api\/digest\/drafts\/(\d+)$/;

export function parseDraftsPath(rest: string): DraftsIntent {
  if (rest === '/api/digest/drafts') return { kind: 'list' };
  const action = ACTION_RE.exec(rest);
  if (action)
    return {
      kind: 'action',
      id: Number(action[1]),
      action: action[2] as 'save' | 'publish' | 'discard',
    };
  const one = ONE_RE.exec(rest);
  if (one) return { kind: 'one', id: Number(one[1]) };
  return { kind: 'unknown', rest };
}

