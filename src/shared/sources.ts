/**
 * Pluggable source engines for content gathering (news + scholarly).
 *
 * Each engine appends normalized candidates; `gatherSources` orchestrates the
 * engine chain (per mode + engine list), applies the trusted-domain allowlist,
 * dedupes (URL hash + fuzzy title), and optionally pulls full text for thin
 * items (native fetch/HTMLRewriter with a Jina Reader fallback).
 *
 * Reusable by any feature that needs curated web/paper candidates.
 */

import { fetchWithTimeout } from '../core/fetch';
import { decodeEntities } from './telegram-html';

export type CandidateTag = 'headlines' | 'trending' | 'papers' | 'segment';

export interface DigestCandidate {
  tag: CandidateTag;
  title: string;
  url: string;
  source: string;
  date?: string;
  snippet?: string;
  score?: number; // engine signal (points/upvotes) — ranking hint only
}

/**
 * What a source-gathering run needs. Structurally satisfied by the digest
 * feature's resolved config; keeps this module independent of any feature.
 */
export interface SourceQuery {
  mode: 'news' | 'papers' | 'both';
  newsEngines: string[];
  scholarEngines: string[];
  topics: string[];
  includeDomains: string[];
  minPoints: number;
  arxivCats: string[];
  gnewsLocale: string;
  rssFeeds: string[];
  maxItems: number;
  fetchFulltext: boolean;
  tavilyKey?: string;
  exaKey?: string;
  jinaKey?: string;
  llamaKey?: string;
}


/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeEntities(stripCdata(m[1])).trim() : '';
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize a URL for hashing: strip protocol, www, query, fragment, slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Jaccard similarity of token sets — cheap cross-language title dedupe. */
function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a).split(' ').filter((t) => t.length > 1));
  const B = new Set(normalizeTitle(b).split(' ').filter((t) => t.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function inAllowlist(url: string, allow: string[]): boolean {
  if (!allow.length) return true;
  const host = domainOf(url);
  if (!host) return false;
  return allow.some((d) => host === d || host.endsWith('.' + d));
}

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

function firstTagBlock(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

async function engineGnews(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  // gnewsLocale may be a comma-separated list of locales (the `tech` preset
  // queries en-US AND zh-CN). Run one fetch per locale and merge — the later
  // dedupe pass (URL hash + fuzzy title) collapses any cross-locale overlap.
  const locales = (q.gnewsLocale || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const query = encodeURIComponent(q.topics.join(' OR '));
  for (const locale of locales) {
    const url = `https://news.google.com/rss/search?q=${query}&${locale}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) continue;
    const xml = await res.text();
    for (const item of firstTagBlock(xml, 'item').slice(0, 6)) {
      const title = tagText(item, 'title');
      const link = tagText(item, 'link');
      if (!title || !link) continue;
      const sourceEl = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(item);
      out.push({
        tag: 'headlines',
        title,
        url: link,
        source: sourceEl
          ? decodeEntities(stripCdata(sourceEl[1])).trim() || domainOf(link)
          : domainOf(link),
        date: tagText(item, 'pubDate'),
      });
    }
  }
}

async function engineHn(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const query = encodeURIComponent(q.topics.join(' OR '));
  const url =
    `https://hn.algolia.com/api/v1/search?query=${query}&tags=story` +
    `&hitsPerPage=8&numericFilters=created_at_i>${since},points>${q.minPoints}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    hits?: {
      title?: string;
      url?: string;
      points?: number;
      objectID?: string;
      created_at?: string;
      story_text?: string;
    }[];
  } | null;
  for (const h of json?.hits ?? []) {
    if (!h.title || !h.url) continue;
    out.push({
      tag: 'trending',
      title: h.title,
      url: h.url,
      source: domainOf(h.url) || 'Hacker News',
      date: h.created_at,
      score: h.points,
      // story_text is Ask/Show HN self-text — already in the response, so this
      // costs zero extra requests and often clears the ≥200-char fulltext gate.
      snippet: h.story_text?.replace(/\s+/g, ' ').trim().slice(0, 1200) || undefined,
    });
  }
}

async function engineArxiv(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  if (!q.arxivCats.length) return;
  const qs = q.arxivCats.map((c) => `cat:${c}`).join('+OR+');
  const url =
    `https://export.arxiv.org/api/query?search_query=${qs}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=8`;
  let res = await fetchWithTimeout(url, {}, 15_000);
  if (res.status === 429) {
    // arXiv throttles aggressively (shared IPs); one polite retry (plan §10).
    await new Promise((r) => setTimeout(r, 15_000));
    res = await fetchWithTimeout(url, {}, 15_000);
  }
  if (!res.ok) return;
  const xml = await res.text();
  for (const entry of firstTagBlock(xml, 'entry').slice(0, 6)) {
    const title = tagText(entry, 'title').replace(/\s+/g, ' ');
    const summary = tagText(entry, 'summary').replace(/\s+/g, ' ');
    const id = tagText(entry, 'id');
    if (!title || !id) continue;
    // Papers get rich context: full abstract + authors + primary category
    // (the LLM summarizes; truncation here was why paper digests felt thin).
    const authors = (entry.match(/<name>([\s\S]*?)<\/name>/g) ?? [])
      .map((m) => m.replace(/<\/?name>/g, '').trim())
      .filter(Boolean);
    const cat =
      /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1] ??
      /<category[^>]*term="([^"]+)"/.exec(entry)?.[1] ??
      '';
    const who = authors.length
      ? 'Authors: ' + authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' et al.' : '') + ' · '
      : '';
    const catPart = cat ? '[' + cat + '] ' : '';
    out.push({
      tag: 'papers',
      title,
      url: id,
      source: 'arXiv',
      date: tagText(entry, 'published'),
      snippet: (catPart + who + summary).replace(/\s+/g, ' ').slice(0, 1200),
    });
  }
}

async function engineHfPapers(out: DigestCandidate[]): Promise<void> {
  const res = await fetchWithTimeout(
    'https://huggingface.co/api/daily_papers?limit=20',
    {},
    15_000,
  );
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as
    | { paper?: { title?: string; summary?: string; id?: string; upvotes?: number } }[]
    | null;
  const items = (json ?? [])
    .filter((x) => x.paper?.title)
    .sort((a, b) => (b.paper?.upvotes ?? 0) - (a.paper?.upvotes ?? 0))
    .slice(0, 6);
  for (const p of items) {
    const id = p.paper?.id ?? '';
    out.push({
      tag: 'papers',
      title: p.paper!.title!,
      url: `https://huggingface.co/papers/${id}`,
      source: 'Hugging Face',
      score: p.paper?.upvotes,
      snippet: (p.paper?.summary ?? '').replace(/\s+/g, ' ').slice(0, 1200),
    });
  }
}

async function engineSemanticScholar(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  if (!q.topics.length) return;
  // Public Graph API — no key required. Docs:
  // https://api.semanticscholar.org/api-docs/graph#tag/Paper-Data/operation/get_graph_get_paper_search
  const fields =
    'title,year,abstract,authors,citationCount,influentialCitationCount,url,externalIds,publicationDate,venue';
  const query = q.topics.join(' OR ');
  const url =
    'https://api.semanticscholar.org/graph/v1/paper/search' +
    `?query=${encodeURIComponent(query)}&limit=8&fields=${encodeURIComponent(fields)}`;
  let res = await fetchWithTimeout(url, {}, 15_000);
  if (res.status === 429) {
    // Public tier is rate-limited; one polite retry before giving up.
    await new Promise((r) => setTimeout(r, 4000));
    res = await fetchWithTimeout(url, {}, 15_000);
  }
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    data?: SemanticScholarPaper[];
  } | null;
  for (const p of json?.data ?? []) {
    if (!p.title) continue;
    // Prefer the arXiv canonical URL when available; otherwise the S2 page.
    const arxivId = p.externalIds?.ArXiv;
    const paperUrl = arxivId
      ? `https://arxiv.org/abs/${arxivId}`
      : p.url || '';
    if (!paperUrl) continue;
    const authors = (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n);
    const venue = p.venue?.trim();
    const who = authors.length
      ? 'Authors: ' +
        authors.slice(0, 4).join(', ') +
        (authors.length > 4 ? ' et al.' : '') +
        ' · '
      : '';
    const where = venue ? `[${venue}] ` : '';
    out.push({
      tag: 'papers',
      title: p.title.replace(/\s+/g, ' ').trim(),
      url: paperUrl,
      source: venue || domainOf(paperUrl) || 'Semantic Scholar',
      date: p.publicationDate,
      snippet:
        (where + who + (p.abstract ?? '')).replace(/\s+/g, ' ').slice(0, 1200) ||
        undefined,
      score: p.influentialCitationCount ?? p.citationCount,
    });
  }
}

/** One paper hit from the Semantic Scholar Graph search endpoint. */
interface SemanticScholarPaper {
  title?: string;
  year?: number;
  abstract?: string;
  venue?: string;
  publicationDate?: string;
  url?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  externalIds?: { ArXiv?: string; DOI?: string; [k: string]: string | undefined };
  authors?: { authorId?: string; name?: string }[];
}

async function engineTavily(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  if (!q.tavilyKey) return;
  const res = await fetchWithTimeout(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${q.tavilyKey}`,
      },
      body: JSON.stringify({
        query: q.topics.join(' OR '),
        topic: 'news',
        days: 2,
        max_results: 8,
        include_domains: q.includeDomains.length ? q.includeDomains : undefined,
      }),
    },
    15_000,
  );
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    results?: { title?: string; url?: string; content?: string }[];
  } | null;
  for (const r of json?.results ?? []) {
    if (!r.title || !r.url) continue;
    out.push({
      tag: 'headlines',
      title: r.title,
      url: r.url,
      source: domainOf(r.url),
      snippet: (r.content ?? '').slice(0, 300),
    });
  }
}

async function engineExa(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  if (!q.exaKey) return;
  const start = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const res = await fetchWithTimeout(
    'https://api.exa.ai/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': q.exaKey,
      },
      body: JSON.stringify({
        query: q.topics.join(' OR '),
        numResults: 8,
        startPublishedDate: start,
        category: 'news',
        contents: { text: { maxCharacters: 300 } },
      }),
    },
    15_000,
  );
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    results?: {
      title?: string;
      url?: string;
      publishedDate?: string;
      text?: string;
    }[];
  } | null;
  for (const r of json?.results ?? []) {
    if (!r.title || !r.url) continue;
    out.push({
      tag: 'headlines',
      title: r.title,
      url: r.url,
      source: domainOf(r.url),
      date: r.publishedDate,
      snippet: (r.text ?? '').slice(0, 300),
    });
  }
}

async function engineRss(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  const since = Date.now() - 48 * 3600 * 1000;
  for (const feed of q.rssFeeds.slice(0, 4)) {
    try {
      const res = await fetchWithTimeout(feed, {}, 10_000);
      if (!res.ok) continue;
      const xml = (await res.text()).slice(0, 2_000_000); // size guard (10 MB feeds)
      const blocks = [...firstTagBlock(xml, 'item'), ...firstTagBlock(xml, 'entry')];
      for (const item of blocks.slice(0, 5)) {
        const rawTitle = tagText(item, 'title');
        const title = rawTitle.replace(/<[^>]*>/g, '').trim();
        const link =
          tagText(item, 'link') ||
          /<link[^>]*href="([^"]+)"/i.exec(item)?.[1] ||
          '';
        if (!title || !link) continue;
        const dateStr = tagText(item, 'pubDate') || tagText(item, 'updated');
        const ts = dateStr ? Date.parse(dateStr) : NaN;
        if (Number.isFinite(ts) && ts < since) continue; // recency filter
        const desc = tagText(item, 'description') || tagText(item, 'summary');
        out.push({
          tag: 'headlines',
          title: title.replace(/<[^>]*>/g, '').trim(),
          url: link.trim(),
          source: domainOf(feed),
          date: dateStr || undefined,
          snippet: desc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 280),
        });
      }
    } catch {
      // feed unreachable — degrade per plan §10
    }
  }
}

/** Run all configured engines; returns deduped, allowlist-filtered candidates. */
export async function gatherSources(q: SourceQuery): Promise<DigestCandidate[]> {
  const out: DigestCandidate[] = [];
  const jobs: Promise<void>[] = [];
  for (const engine of q.newsEngines) {
    if (engine === 'gnews') jobs.push(engineGnews(q, out));
    else if (engine === 'hn') jobs.push(engineHn(q, out));
    else if (engine === 'rss') jobs.push(engineRss(q, out));
    else if (engine === 'tavily') jobs.push(engineTavily(q, out));
    else if (engine === 'exa') jobs.push(engineExa(q, out));
    else if (engine === 'jsearch') jobs.push(engineJsearch(q, out));
  }
  if (q.mode !== 'news') {
    for (const engine of q.scholarEngines) {
      if (engine === 'arxiv') jobs.push(engineArxiv(q, out));
      else if (engine === 'hf') jobs.push(engineHfPapers(out));
      else if (engine === 's2') jobs.push(engineSemanticScholar(q, out));
    }
  }
  await Promise.allSettled(jobs);

  // Dedupe: URL hash first, then fuzzy title (cross-language duplicates).
  const seenUrls = new Set<string>();
  const seenTitles: string[] = [];
  const deduped: DigestCandidate[] = [];
  for (const c of out) {
    if (!c.url || !c.title || !inAllowlist(c.url, q.includeDomains)) continue;
    const urlKey = normalizeUrl(c.url);
    if (seenUrls.has(urlKey)) continue;
    if (seenTitles.some((t) => titleSimilarity(t, c.title) >= 0.6)) continue;
    seenUrls.add(urlKey);
    seenTitles.push(c.title);
    deduped.push(c);
  }

  // Rank: papers by score, trending by score, then recency-ish order preserved.
  return deduped
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Optional full-text extraction (native HTMLRewriter, Jina fallback)   */
/* ------------------------------------------------------------------ */

export async function extractArticleText(html: string, cap = 1200): Promise<string> {
  let article = '';
  let body = '';
  let skipDepth = 0;
  let articleDepth = 0;
  const SKIP = new Set([
    'script', 'style', 'noscript', 'svg', 'nav', 'header',
    'footer', 'aside', 'form', 'select', 'button', 'iframe',
  ]);
  const rewriter = new HTMLRewriter().on('*', {
    element(el) {
      const tag = el.tagName;
      if (SKIP.has(tag)) {
        skipDepth++;
        el.onEndTag(() => {
          skipDepth--;
        });
      }
      if (tag === 'article') {
        articleDepth++;
        el.onEndTag(() => {
          articleDepth--;
        });
      }
    },
    text(t) {
      if (skipDepth > 0 || !t.text) return;
      if (articleDepth > 0) article += t.text;
      body += t.text;
      if (t.lastInTextNode) {
        if (articleDepth > 0) article += ' ';
        body += ' ';
      }
    },
  });
  await rewriter.transform(new Response(html)).arrayBuffer(); // drain
  const pick = article.trim().length > 200 ? article : body;
  return pick.replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * Jina Reader fallback extraction. JSON mode (`Accept: application/json`) when
 * keyed: structured `data.content` beats scraping raw markdown, and
 * `data.usage.tokens` enables budget accounting. Keyed calls get 500 RPM and
 * escape the anonymous abuse block; keyless calls still work at 20 RPM.
 */
export async function extractViaJina(
  q: SourceQuery,
  url: string,
  cap = 1200,
): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (q.jinaKey) headers.Authorization = `Bearer ${q.jinaKey}`;
  const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 20_000);
  if (!res.ok) return '';
  const json = (await res.json().catch(() => null)) as {
    data?: { content?: string };
  } | null;
  const content = json?.data?.content;
  if (typeof content !== 'string') return '';
  return content.replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * LlamaParse document extraction — the PDF/files specialist. Never used for
 * HTML (Jina does HTML better and effectively free; LlamaParse bills every
 * page). Fast tier = 1 credit/page against the 10K free monthly pool; results
 * are cached server-side for 48h, so re-parses within that window are free.
 */
export async function extractViaLlamaParse(
  q: SourceQuery,
  url: string,
  cap = 1200,
): Promise<string> {
  if (!q.llamaKey) return '';
  try {
    const create = await fetchWithTimeout(
      'https://api.cloud.llamaindex.ai/api/parsing/upload/file',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${q.llamaKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({ file_url: url, parsing_mode: 'fast' }),
      },
      30_000,
    );
    if (!create.ok) return '';
    const job = (await create.json().catch(() => null)) as { id?: string } | null;
    if (!job?.id) return '';
    // Poll for completion (typical PDF: a few seconds; 48h cache makes retries free).
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      const poll = await fetchWithTimeout(
        `https://api.cloud.llamaindex.ai/api/parsing/job/${job.id}/result/text`,
        { headers: { Authorization: `Bearer ${q.llamaKey}` } },
        15_000,
      );
      if (poll.status === 404) continue; // still processing
      if (!poll.ok) return '';
      const text = await poll.text();
      return text.replace(/\s+/g, ' ').trim().slice(0, cap);
    }
  } catch {
    // extraction failure — caller keeps whatever it already has
  }
  return '';
}

/**
 * Jina Search engine (`s.jina.ai`). Requires a key (keyless requests are
 * blocked). Each request costs a FIXED ~10,000 tokens against the shared free
 * pool (~1,000 requests total) — it is an engine (one call per run), never a
 * per-candidate path. Results arrive with extracted page content, so its
 * candidates are usually born past the ≥200-char fulltext gate.
 */
async function engineJsearch(q: SourceQuery, out: DigestCandidate[]): Promise<void> {
  if (!q.jinaKey) return;
  const query = q.topics.join(' ');
  if (!query) return;
  const res = await fetchWithTimeout(
    `https://s.jina.ai/${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${q.jinaKey}`, Accept: 'application/json' } },
    30_000,
  );
  if (!res.ok) return;
  const json = (await res.json().catch(() => null)) as {
    data?: {
      title?: string;
      url?: string;
      description?: string;
      content?: string;
    }[];
  } | null;
  for (const r of json?.data ?? []) {
    if (!r.title || !r.url) continue;
    out.push({
      tag: 'headlines',
      title: r.title.replace(/\s+/g, ' ').trim(),
      url: r.url,
      source: domainOf(r.url) || 'Jina',
      snippet: (r.content || r.description || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1200),
    });
  }
}

