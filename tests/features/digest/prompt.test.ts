import { describe, expect, it } from 'vitest';
import { buildDailyPrompt, buildDeepPrompt } from '../../../src/features/digest/pipeline';
import type { DigestConfig } from '../../../src/features/digest/config';
import type { DigestCandidate } from '../../../src/shared/sources';

const cfg = (over: Partial<DigestConfig> = {}): DigestConfig => ({
  domain: 'tech',
  rotation: null,
  effectiveDomain: 'tech',
  mode: 'both',
  topics: ['large language models'],
  newsEngines: ['gnews'],
  scholarEngines: ['arxiv'],
  arxivCats: ['cs.AI'],
  includeDomains: [],
  minPoints: 0,
  maxItems: 5,
  fetchFulltext: false,
  extractMax: 4,
  targetChatId: '-1001000001',
  weeklyEnabled: false,
  weeklyDay: 0,
  monthlyEnabled: false,
  monthlyDay: 1,
  language: 'English',
  autoPublish: false,
  draftTtlDays: 7,
  deepBodyLimit: 7900,
  postAnalytics: false,
  gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
  rssFeeds: [],
  llm: {
    baseUrl: 'https://llm.example/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 3000,
    timeoutMs: 60_000,
    jsonMode: true,
  },
  ...over,
});

const candidates: DigestCandidate[] = [
  { tag: 'papers', title: 'A Great Paper', url: 'https://arxiv.org/abs/2401.00001', source: 'arXiv', snippet: 'An abstract.' },
  { tag: 'headlines', title: 'A News Story', url: 'https://example.com/1', source: 'Example', snippet: 'A summary.' },
];

describe('buildDailyPrompt — source link contract', () => {
  it('instructs the LLM to put the source INLINE and in ITALIC, on the same line', () => {
    const prompt = buildDailyPrompt(cfg(), candidates);

    // Inline + italic, never a separate line.
    expect(prompt).toContain('<a href="s{n}"><i>{source}</i></a>');
    expect(prompt).toContain('INLINE');
    expect(prompt).toContain('italic');
    expect(prompt).toContain('Never put the source on a separate line');
  });

  it('still forbids full URLs (the s{n} contract) and caps at 3500 chars', () => {
    const prompt = buildDailyPrompt(cfg(), candidates);
    expect(prompt).toContain('href="s{n}"');
    expect(prompt).toContain('NEVER write full URLs anywhere in your response');
    expect(prompt).toContain('3500 characters');
  });

  it('serializes the candidates as numbered JSON for the LLM to reference', () => {
    const prompt = buildDailyPrompt(cfg(), candidates);
    expect(prompt).toContain('"n":1');
    expect(prompt).toContain('A Great Paper');
    expect(prompt).toContain('"n":2');
    expect(prompt).toContain('A News Story');
  });
});

describe('buildDeepPrompt — deep-dive contract', () => {
  it('asks for the richer analytical format while keeping the s{n} source contract', () => {
    const prompt = buildDeepPrompt(cfg({ mode: 'news' }), candidates);

    // Richer instruction (3-5 sentences + synthesis) — the deep variant.
    expect(prompt).toContain('DEEP-DIVE');
    expect(prompt).toContain('3-5 sentences');
    expect(prompt).toContain('synthesis');

    // Same source contract as the daily prompt.
    expect(prompt).toContain('<a href="s{n}"><i>{source}</i></a>');
    expect(prompt).toContain('NEVER write full URLs anywhere in your response');
    // Deep carries its own (higher) cap and the anti-fabrication guard.
    expect(prompt).toContain('5000 characters');
    expect(prompt).toContain('never fabricate details');
  });

  it('serializes today\'s published items with their extracted text', () => {
    const prompt = buildDeepPrompt(cfg({ mode: 'news' }), candidates);
    expect(prompt).toContain('"n":1');
    expect(prompt).toContain('An abstract.');
  });
});
