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

const DOMAIN_PRESETS: Record<string, DomainPreset> = {
  tech: {
    topics: [
      'artificial intelligence',
      'developer tools',
      'cloud computing',
      'cybersecurity',
    ],
    newsEngines: ['gnews', 'hn'],
    scholarEngines: ['arxiv', 'hf'],
    arxivCats: ['cs.AI', 'cs.CL', 'cs.LG'],
    includeDomains: [],
    gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
    rssFeeds: [],
  },
  'tech-zh': {
    topics: ['人工智能', '大模型', '开发者工具', '云计算'],
    newsEngines: ['gnews'],
    scholarEngines: ['arxiv', 'hf'],
    arxivCats: ['cs.AI', 'cs.CL', 'cs.LG'],
    includeDomains: [],
    gnewsLocale: 'hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
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
    arxivCats: [],
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
    arxivCats: [],
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

export interface DigestConfig {
  domain: string;
  mode: DigestMode;
  topics: string[];
  newsEngines: string[];
  scholarEngines: string[];
  arxivCats: string[];
  includeDomains: string[];
  minPoints: number;
  maxItems: number;
  fetchFulltext: boolean;
  targetChatId: string;
  publishHours: number[];
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
  gnewsLocale: string;
  rssFeeds: string[];
}


export function resolveDigestConfig(env: Env): DigestConfig {
  const domain = (env.NEWS_DOMAIN || 'tech').trim();
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

  const hours = envList(env.NEWS_PUBLISH_HOURS)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);

  return {
    domain,
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
    fetchFulltext: (env.NEWS_FETCH_FULLTEXT || '').trim() === 'true',
    targetChatId: (env.NEWS_TARGET_CHAT_ID || '').trim(),
    publishHours: hours.length ? hours : [9],
    weeklyEnabled: (env.NEWS_ENABLE_WEEKLY || '') === 'true',
    weeklyDay: Number(env.NEWS_WEEKLY_DAY ?? 0) || 0,
    monthlyEnabled: (env.NEWS_ENABLE_MONTHLY || '') === 'true',
    monthlyDay: Number(env.NEWS_MONTHLY_DAY ?? 1) || 1,
    language: env.NEWS_LANGUAGE?.trim() || 'English',
    dialect: env.NEWS_DIALECT?.trim() || undefined,
    autoPublish: (env.NEWS_AUTO_PUBLISH || '').trim().toLowerCase() === 'true',
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
      maxTokens: Number(env.DIGEST_MAX_TOKENS) || 2048,
      timeoutMs: Number(env.DIGEST_TIMEOUT_MS) || 120_000,
      extraBody: env.DIGEST_EXTRA_BODY_JSON || env.LLM_EXTRA_BODY_JSON,
      jsonMode: (env.DIGEST_RESPONSE_FORMAT ?? 'json') === 'json',
    },
    tavilyKey: env.TAVILY_API_KEY,
    exaKey: env.EXA_API_KEY,
    jinaKey: env.JINA_API_KEY,
    gnewsLocale: preset.gnewsLocale,
    rssFeeds: envList(env.NEWS_RSS_FEEDS).length
      ? envList(env.NEWS_RSS_FEEDS)
      : preset.rssFeeds,
  };
}

