import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractViaJina,
  extractViaLlamaParse,
  gatherSources,
} from '../../src/shared/sources';
import type { SourceQuery } from '../../src/shared/sources';

/** Minimal SourceQuery: s2 is a scholar engine so only topics + mode matter. */
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

const S2_BODY = {
  total: 2,
  data: [
    {
      paperId: 'abc123',
      title: '  Attention Is All You  Need ',
      year: 2024,
      abstract: 'A dominant sequence transduction model.',
      venue: '  NeurIPS  ',
      publicationDate: '2024-01-15',
      citationCount: 99,
      influentialCitationCount: 42,
      url: 'https://www.semanticscholar.org/paper/abc123',
      externalIds: { ArXiv: '2401.00001' },
      authors: [{ authorId: '1', name: 'A. Vaswani' }, { authorId: '2', name: 'B. Shazeer' }],
    },
    // No arXiv id -> should fall back to the S2 url.
    {
      paperId: 'def456',
      title: 'BERT: Pre-training',
      abstract: 'Bidirectional transformers.',
      venue: '',
      citationCount: 5,
      url: 'https://www.semanticscholar.org/paper/def456',
    },
  ],
};

function mockFetchOnce(args: { status: number; body: unknown }): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(args.body), { status: args.status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('engineSemanticScholar (s2)', () => {
  beforeEach(() => {
    // crypto.subtle is present in the vitest node env; sha256Hex depends on it.
  });

  it('maps hits to paper candidates with authors, venue, score, and a snippet', async () => {
    mockFetchOnce({ status: 200, body: S2_BODY });
    const cands = await gatherSources(baseQuery());

    expect(cands.length).toBe(2);
    const [first, second] = cands;

    // Title whitespace collapsed, score prefers influential count.
    expect(first.title).toBe('Attention Is All You Need');
    expect(first.tag).toBe('papers');
    expect(first.score).toBe(42);
    expect(first.date).toBe('2024-01-15');

    // Prefers the canonical arXiv URL when externalIds.ArXiv is present.
    expect(first.url).toBe('https://arxiv.org/abs/2401.00001');

    // Snippet carries venue + authors + abstract, whitespace-collapsed.
    expect(first.snippet).toContain('[NeurIPS]');
    expect(first.snippet).toContain('Authors: A. Vaswani, B. Shazeer');
    expect(first.snippet).toContain('A dominant sequence transduction model.');

    // No arXiv id -> falls back to the S2 paper URL.
    expect(second.url).toBe('https://www.semanticscholar.org/paper/def456');
    // Empty venue -> no [venue] tag; citationCount used when no influential count.
    expect(second.score).toBe(5);
    expect(second.snippet).not.toMatch(/^\[/);
  });

  it('retries once on 429 and still returns candidates', async () => {
    const calls: string[] = [];
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        attempt += 1;
        if (attempt === 1) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify(S2_BODY), { status: 200 });
      }),
    );

    const cands = await gatherSources(baseQuery());
    expect(calls.length).toBe(2); // initial + one retry
    expect(cands.length).toBe(2);
  });

  it('returns [] (and one call, no retry) when the API is not ok after retry', async () => {
    const calls = mockFetchOnce({ status: 500, body: { data: [] } });
    const cands = await gatherSources(baseQuery());
    expect(calls.length).toBe(1); // a plain 500 is not retried (only 429 is)
    expect(cands).toEqual([]);
  });

  it('hits the Graph search endpoint with the right query and field set', async () => {
    const calls = mockFetchOnce({ status: 200, body: S2_BODY });
    await gatherSources(baseQuery({ topics: ['transformer', 'robotics'] }));

    expect(calls.length).toBe(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://api.semanticscholar.org/graph/v1/paper/search');
    expect(url.searchParams.get('query')).toBe('transformer OR robotics');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(url.searchParams.get('fields')).toContain('citationCount');
    expect(url.searchParams.get('fields')).toContain('externalIds');
  });

  it('skips the engine (no fetch) when there are no topics', async () => {
    const calls = mockFetchOnce({ status: 200, body: S2_BODY });
    const cands = await gatherSources(baseQuery({ topics: [] }));
    expect(calls.length).toBe(0);
    expect(cands).toEqual([]);
  });
});

describe('engineHn — story_text snippet', () => {
  it('maps Algolia story_text into the snippet at zero extra cost', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        hits: [
          {
            title: 'Show HN: I built a thing',
            url: 'https://example.dev/thing',
            points: 120,
            objectID: '1',
            created_at: '2026-09-15T00:00:00Z',
            story_text: 'Hi HN! This is my   launch post with details.',
          },
          {
            title: 'A link post',
            url: 'https://example.com/link',
            points: 80,
            objectID: '2',
            created_at: '2026-09-15T01:00:00Z',
            // no story_text -> snippet stays undefined (fulltext chain's job)
          },
        ],
      },
    });
    const cands = await gatherSources(
      baseQuery({ mode: 'news', newsEngines: ['hn'], scholarEngines: [] }),
    );
    expect(cands.length).toBe(2);
    expect(cands[0].snippet).toBe('Hi HN! This is my launch post with details.');
    expect(cands[1].snippet).toBeUndefined();
  });
});

describe('extractViaJina — JSON mode', () => {
  it('parses the structured data.content payload', async () => {
    const calls: string[] = [];
    const headers: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push(String(url));
        const h = new Headers(init?.headers);
        h.forEach((v, k) => headers.push(`${k}:${v}`));
        return new Response(
          JSON.stringify({ code: 200, data: { content: 'Some  extracted\narticle text.' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const text = await extractViaJina(
      baseQuery({ jinaKey: 'jina_test' }),
      'https://example.com/article',
    );
    expect(calls[0]).toBe('https://r.jina.ai/https://example.com/article');
    expect(headers.join('|')).toContain('accept:application/json');
    expect(headers.join('|')).toContain('authorization:Bearer jina_test');
    expect(text).toBe('Some extracted article text.');
  });

  it('returns "" on a non-ok response', async () => {
    mockFetchOnce({ status: 403, body: { code: 40305, message: 'blocked' } });
    const text = await extractViaJina(baseQuery(), 'https://example.com/x');
    expect(text).toBe('');
  });
});

describe('extractViaLlamaParse — PDF documents', () => {
  it('no-ops without a key (no requests, no credit burn)', async () => {
    const calls = mockFetchOnce({ status: 200, body: {} });
    const text = await extractViaLlamaParse(baseQuery(), 'https://arxiv.org/pdf/2401.00001');
    expect(calls.length).toBe(0);
    expect(text).toBe('');
  });
});

describe('engineJsearch — Jina Search as engine', () => {
  const JSEARCH_BODY = {
    code: 200,
    data: [
      {
        title: 'A Search Result',
        url: 'https://news.example.com/story',
        content: 'The page   content extracted by the search API.',
        description: 'short desc',
      },
      { title: '', url: 'https://no-title.example/' }, // skipped: no title
    ],
  };

  it('maps results to headline candidates with extracted content snippets', async () => {
    const calls = mockFetchOnce({ status: 200, body: JSEARCH_BODY });
    const cands = await gatherSources(
      baseQuery({
        mode: 'news',
        newsEngines: ['jsearch'],
        scholarEngines: [],
        jinaKey: 'jina_test',
      }),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('https://s.jina.ai/');
    expect(cands.length).toBe(1);
    expect(cands[0].title).toBe('A Search Result');
    expect(cands[0].source).toBe('news.example.com');
    expect(cands[0].snippet).toBe('The page content extracted by the search API.');
  });

  it('no-ops without a key — jsearch is key-gated like tavily/exa', async () => {
    const calls = mockFetchOnce({ status: 200, body: JSEARCH_BODY });
    const cands = await gatherSources(
      baseQuery({ mode: 'news', newsEngines: ['jsearch'], scholarEngines: [] }),
    );
    expect(calls.length).toBe(0);
    expect(cands).toEqual([]);
  });
});
