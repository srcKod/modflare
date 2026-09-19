
/* ------------------------------------------------------------------ */
/* Diversity-aware candidate selection + not-configured visibility      */
/* ------------------------------------------------------------------ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gatherSourcesDetailed,
  interleaveByEngine,
  describeEngineSkips,
} from '../../src/shared/sources';
import type { DigestCandidate, SourceQuery } from '../../src/shared/sources';

/** Minimal SourceQuery (same shape as sources.test.ts). */
const baseQuery = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  mode: 'papers',
  newsEngines: [],
  scholarEngines: ['s2'],
  topics: ['large language models'],
  includeDomains: [],
  minPoints: 0,
  arxivCats: [],
  gnewsLocale: '',
  rssFeeds: [],
  maxItems: 8,
  fetchFulltext: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fetch stub that routes by URL — multi-engine scenarios need per-engine bodies. */
function routeFetch(
  routes: { match: (u: string) => boolean; status?: number; body?: unknown }[],
): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      const r = routes.find((rt) => rt.match(String(url)));
      const body = r?.body !== undefined ? r.body : {};
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(text, { status: r?.status ?? 200 });
    }),
  );
  return calls;
}

/** Distinct 2+-char words — single digits are dropped as tokens by the
 *  fuzzy title dedupe, which would collapse "paper 0/1/2" into one item. */
const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
];
const word = (i: number) => WORDS[i % WORDS.length];

const arxivXml = (n: number) =>
  '<feed>' +
  Array.from(
    { length: n },
    (_, i) =>
      `<entry><title>Arxiv paper ${word(i)}</title><id>http://arxiv.org/abs/2401.0000${i}</id><summary>Abstract ${i}.</summary></entry>`,
  ).join('') +
  '</feed>';

const hnBody = (n: number) => ({
  hits: Array.from({ length: n }, (_, i) => ({
    title: `HN story ${word(i)}`,
    url: `https://example.com/hn/${i}`,
    points: 100 - i,
    objectID: `hn${i}`,
    created_at: new Date().toISOString(),
  })),
});

const s2Body = (n: number, cites = 90) => ({
  data: Array.from({ length: n }, (_, i) => ({
    title: `S2 paper ${word(i)}`,
    citationCount: cites - i,
    influentialCitationCount: cites - i,
    url: `https://www.semanticscholar.org/paper/s2-${i}`,
  })),
});

const hfBody = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    paper: { title: `HF paper ${word(i)}`, id: `hf-${i}`, upvotes: 40 - i },
  }));

const gnewsXml = (n: number) =>
  '<rss>' +
  Array.from(
    { length: n },
    (_, i) =>
      `<item><title>GNews item ${word(i)}</title><link>https://example.com/g/${i}</link><source>Example</source></item>`,
  ).join('') +
  '</rss>';

const rssXml = (n: number) =>
  '<rss>' +
  Array.from(
    { length: n },
    (_, i) =>
      `<item><title>RSS item ${word(i)}</title><link>https://example.com/r/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`,
  ).join('') +
  '</rss>';

describe('interleaveByEngine — diversity-aware selection', () => {
  const mk = (engine: string, i: number, score?: number): DigestCandidate => ({
    tag: 'headlines',
    title: `${engine} ${i}`,
    url: `https://x.test/${engine}/${i}`,
    source: 'x.test',
    engine,
    score,
  });

  it('round-robins one item per engine per round, strongest signal first', () => {
    const items = [
      mk('a', 0),
      mk('a', 1),
      mk('b', 0, 50),
      mk('b', 1, 10),
      mk('c', 0),
    ];
    const out = interleaveByEngine(items, 4);
    // Round 0 picks a0/b0(50)/c0 → sorted: b0, a0, c0. Round 1: b1(10), a1 —
    // the cap hits after b1, so a1 is cut, not c0's representation.
    expect(out.map((c) => c.title)).toEqual(['b 0', 'a 0', 'c 0', 'b 1']);
  });

  it('a single live engine fills the whole cap (graceful degradation)', () => {
    const items = [mk('hn', 0, 99), mk('hn', 1, 40), mk('hn', 2, 3)];
    const out = interleaveByEngine(items, 12);
    expect(out.map((c) => c.score)).toEqual([99, 40, 3]);
  });

  it('respects cap <= 0 and empty input', () => {
    expect(interleaveByEngine([], 12)).toEqual([]);
    expect(interleaveByEngine([mk('a', 0)], 0)).toEqual([]);
  });
});

describe('gatherSourcesDetailed — arXiv crowd-out regression (review 2)', () => {
  it('keeps arXiv visible when S2 + HF return full scored pages', async () => {
    routeFetch([
      { match: (u) => u.includes('semanticscholar.org'), body: s2Body(8) },
      { match: (u) => u.includes('huggingface.co'), body: hfBody(6) },
      { match: (u) => u.includes('export.arxiv.org'), body: arxivXml(6) },
    ]);
    const rep = await gatherSourcesDetailed(
      baseQuery({ scholarEngines: ['arxiv', 'hf', 's2'], arxivCats: ['cs.AI'] }),
    );
    expect(rep.failures).toEqual([]);
    expect(rep.candidates.length).toBe(12);
    // Old behavior: s2(8) + hf(6) = 14 scored items filled the cap and arXiv
    // (unscored) got zero candidates. Round-robin gives each engine ~4.
    const byEngine = (name: string) =>
      rep.candidates.filter((c) => c.engine === name).length;
    expect(byEngine('arxiv')).toBe(4);
    expect(byEngine('hf')).toBe(4);
    expect(byEngine('s2')).toBe(4);
  });

  it('headlines: rss survives a full page of scored HN hits', async () => {
    routeFetch([
      { match: (u) => u.includes('hn.algolia.com'), body: hnBody(8) },
      { match: (u) => u.includes('news.google.com'), body: gnewsXml(6) },
      { match: (u) => u.includes('feeds.example'), body: rssXml(5) },
    ]);
    const rep = await gatherSourcesDetailed(
      baseQuery({
        mode: 'news',
        newsEngines: ['gnews', 'hn', 'rss'],
        scholarEngines: [],
        gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
        rssFeeds: ['https://feeds.example/feed.xml'],
        minPoints: 25,
      }),
    );
    expect(rep.failures).toEqual([]);
    expect(rep.candidates.length).toBe(12);
    const byEngine = (name: string) =>
      rep.candidates.filter((c) => c.engine === name).length;
    expect(byEngine('gnews')).toBe(4);
    expect(byEngine('hn')).toBe(4);
    expect(byEngine('rss')).toBe(4); // old behavior: 0
  });

  it('failed engines drop out; the survivor fills the cap in score order', async () => {
    routeFetch([
      { match: (u) => u.includes('hn.algolia.com'), body: hnBody(8) },
      { match: (u) => u.includes('news.google.com'), status: 503, body: '' },
      { match: (u) => u.includes('feeds.example'), status: 503, body: '' },
    ]);
    const rep = await gatherSourcesDetailed(
      baseQuery({
        mode: 'news',
        newsEngines: ['gnews', 'hn', 'rss'],
        scholarEngines: [],
        gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
        rssFeeds: ['https://feeds.example/feed.xml'],
      }),
    );
    expect(rep.failures.sort()).toEqual(['gnews', 'rss']);
    expect(rep.candidates.length).toBe(8);
    expect(rep.candidates.every((c) => c.engine === 'hn')).toBe(true);
    const scores = rep.candidates.map((c) => c.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('engineSkips — not-configured visibility (review 2)', () => {
  it('lists key-gated engines as skipped when their keys are missing', async () => {
    routeFetch([
      { match: (u) => u.includes('hn.algolia.com'), body: { hits: [] } },
      { match: (u) => u.includes('news.google.com'), body: '<rss></rss>' },
      { match: (u) => u.includes('feeds.example'), body: rssXml(1) },
    ]);
    const rep = await gatherSourcesDetailed(
      baseQuery({
        mode: 'news',
        newsEngines: ['gnews', 'hn', 'rss', 'tavily', 'exa', 'jsearch'],
        scholarEngines: [],
        gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
        rssFeeds: ['https://feeds.example/feed.xml'],
      }),
    );
    expect(rep.skipped).toEqual(['tavily', 'exa', 'jsearch']);
    expect(rep.failures).toEqual([]);
  });

  it('does not skip key-gated engines when keys are present', async () => {
    routeFetch([
      { match: (u) => u.includes('hn.algolia.com'), body: { hits: [] } },
      { match: (u) => u.includes('news.google.com'), body: '<rss></rss>' },
      { match: (u) => u.includes('feeds.example'), body: rssXml(1) },
      { match: (u) => u.includes('api.tavily.com'), body: { results: [] } },
      { match: (u) => u.includes('api.exa.ai'), body: { results: [] } },
      { match: (u) => u.includes('s.jina.ai'), body: { data: [] } },
    ]);
    const rep = await gatherSourcesDetailed(
      baseQuery({
        mode: 'news',
        newsEngines: ['gnews', 'hn', 'rss', 'tavily', 'exa', 'jsearch'],
        scholarEngines: [],
        gnewsLocale: 'hl=en-US&gl=US&ceid=US:en',
        rssFeeds: ['https://feeds.example/feed.xml'],
        tavilyKey: 'tvly_test',
        exaKey: 'exa_test',
        jinaKey: 'jina_test',
      }),
    );
    expect(rep.skipped).toEqual([]);
    expect(rep.failures).toEqual([]);
  });

  it('flags rss without feeds and arxiv without categories', async () => {
    routeFetch([]);
    const news = await gatherSourcesDetailed(
      baseQuery({ mode: 'news', newsEngines: ['rss'], scholarEngines: [], rssFeeds: [] }),
    );
    expect(news.skipped).toEqual(['rss']);
    expect(news.failures).toEqual([]);
    const papers = await gatherSourcesDetailed(
      baseQuery({ scholarEngines: ['arxiv'], arxivCats: [] }),
    );
    expect(papers.skipped).toEqual(['arxiv']);
    expect(papers.failures).toEqual([]);
  });

  it('describeEngineSkips names each engine with an actionable hint', () => {
    const r = describeEngineSkips(['tavily', 'rss']);
    expect(r.reason).toContain('tavily, rss');
    expect(r.hint).toContain('TAVILY_API_KEY');
    expect(r.hint).toContain('NEWS_RSS_FEEDS');
  });
});
