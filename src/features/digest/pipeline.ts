/**
 * Digest pipeline: prompt assembly, LLM call, tolerant JSON parse, slot
 * idempotency, the cron gate (daily/weekly/monthly), reaction capture, and
 * retention pruning. Delivery/transport live in core; source engines in
 * shared/sources.
 */

import { envBool, envList } from '../../core/config';
import { makeLogger } from '../../core/logger';
import type { AuditLogger } from '../../core/logger';
import { chatCompletion } from '../../core/llm';
import { fetchWithTimeout } from '../../core/fetch';
import {
  sendMessageDetailed,
  notifyAdmins,
  getChatMemberCount,
} from '../../core/telegram';
import type { SendResult } from '../../core/telegram';
import type { Env, TelegramUpdate } from '../../core/types';
import { sanitizeTelegramHtml, renderedLength } from '../../shared/telegram-html';
import {
  gatherSources,
  extractArticleText,
  extractViaJina,
  extractViaLlamaParse,
  domainOf,
  sha256Hex,
  normalizeUrl,
} from '../../shared/sources';
import type { DigestCandidate } from '../../shared/sources';
import {
  resolveDigestConfig,
  isRotationDomain,
  ROTATION_PRESETS,
  parseSchedule,
  hasSchedule,
  rollupHourFromSchedule,
} from './config';
import type { DigestContentType, SlotConfig } from './config';
import type { DigestConfig } from './config';
import { digestAdminRoutes } from './admin';

/* ------------------------------------------------------------------ */
/* LLM: prompt + call + tolerant parse                                 */
/* ------------------------------------------------------------------ */

interface DigestLlmResult {
  title: string;
  post: string;
  items: { url: string; title: string }[];
}

function langHint(cfg: DigestConfig): string {
  return cfg.dialect
    ? `${cfg.language} (dialect: ${cfg.dialect})`
    : cfg.language;
}

export function buildDailyPrompt(cfg: DigestConfig, candidates: DigestCandidate[]): string {
  const lines = [
    `You are the editor of a professional technology digest channel on Telegram.`,
    `You receive JSON candidates from the last 24-48h (fields: n, tag, title, source, url, date, snippet).`,
    `Select the ${cfg.maxItems} most significant, distinct items (prefer trending signals; skip minor news and near-duplicates).`,
    `Write the final post as Telegram HTML:`,
    `- First line: 📰 <b>a headline for today's digest</b>`,
    `- Then for each selected item, one block: • <b>item title</b> — a 1-2 sentence factual, professional summary (no hype, no invented facts), with the source appended INLINE at the end of the same line in italic: <a href="s{n}"><i>{source}</i></a> where {n} is that item's candidate number and {source} is its source name. Never put the source on a separate line.`,
    `- End with a line: — · {n} sources`,
    `Write ONLY in ${langHint(cfg)}; candidates may be in English, Chinese, or Arabic — always output in ${langHint(cfg)}.`,
    `Use only these Telegram HTML tags: <b> <i> <u> <s> <a href="s{n}"> <code> <blockquote>. Escape & < > in visible text.`,
    `Hard cap: 3500 characters. Never add items that are not in the candidate list.`,
    ``,
    `IMPORTANT: every link href MUST be exactly href="s{n}" using the candidate number — NEVER write full URLs anywhere in your response. The server replaces s{n} with the real URL.`,
    `Respond with ONLY a JSON object: {"title": "...", "post": "...", "items": [{"n": 1, "title": "..."}]}`,
    `where "items" lists the candidate numbers and titles you selected, in order.`,
    ``,
    `CANDIDATES:`,
    JSON.stringify(
      candidates.map((c, i) => ({
        n: i + 1,
        tag: c.tag,
        title: c.title,
        source: c.source,
        url: c.url,
        date: c.date,
        snippet: c.snippet,
      })),
    ),
  ];
  return lines.join('\n');
}

/**
 * Deep-dive prompt — the richer-prompt variant for `deep` slots. Input is
 * today's already-published items, optionally carrying the full extracted
 * article text. Analytical, longer-form, but bound to the same source contract:
 * s{n} references only, no invented facts beyond what the snippet/title gives.
 */
export function buildDeepPrompt(cfg: DigestConfig, items: DigestCandidate[]): string {
  const lines = [
    `You are the editor writing the DEEP-DIVE edition of a professional technology digest channel on Telegram.`,
    `You receive items ALREADY published in today's headlines digest; some include the full extracted article text (field snippet) — analyze from it, never invent beyond it.`,
    `Write the post as Telegram HTML:`,
    `- First line: 🔍 <b>a deep-dive headline for today's digest</b>`,
    `- Then for each significant item: • <b>item title</b> — 3-5 sentences of professional analysis: what happened, why it matters now, and concrete implications. Append the source INLINE at the end of the same line in italic: <a href="s{n}"><i>{source}</i></a> where {n} is that item's number and {source} is its source name. Never put the source on a separate line.`,
    `- End with one short synthesis paragraph (2-4 sentences): the common thread across today's items — no new items.`,
    `Write ONLY in ${langHint(cfg)}; items may be in English, Chinese, or Arabic — always output in ${langHint(cfg)}.`,
    `Use only these Telegram HTML tags: <b> <i> <u> <s> <a href="s{n}"> <code> <blockquote>. Escape & < > in visible text.`,
    `Hard cap: 5000 characters. Never add items that are not in the list. If an item has no snippet, analyze from the title only — never fabricate details.`,
    ``,
    `IMPORTANT: every link href MUST be exactly href="s{n}" using the item number — NEVER write full URLs anywhere in your response. The server replaces s{n} with the real URL.`,
    `Respond with ONLY a JSON object: {"title": "...", "post": "...", "items": [{"n": 1, "title": "..."}]}`,
    `where "items" lists the item numbers and titles you covered, in order.`,
    ``,
    `TODAY'S PUBLISHED ITEMS:`,
    JSON.stringify(
      items.map((c, i) => ({
        n: i + 1,
        title: c.title,
        source: c.source,
        url: c.url,
        snippet: c.snippet,
      })),
    ),
  ];
  return lines.join('\n');
}

function buildHistoryPrompt(
  cfg: DigestConfig,
  type: 'weekly' | 'monthly',
  rows: { title: string; url: string; source: string; reactions: number | null }[],
): string {
  const period = type === 'weekly' ? 'week' : 'month';
  return [
    `You are the editor of a professional technology digest channel on Telegram.`,
    `Build the ${period}ly roundup from items ALREADY published in daily digests during the past ${period}.`,
    `Fields: n, title, source, url, reactions (audience 👍 signal). Pick the top ${type === 'weekly' ? 5 : 10} by significance + reactions, group into 1-3 short themes, and note the biggest story.`,
    `Write the post as Telegram HTML in ${langHint(cfg)}:`,
    `- First line: ${type === 'weekly' ? '🗓' : '📆'} <b>${period} roundup headline</b>`,
    `- Themes as short <b>theme</b> lines with 1-line items (title, then the source appended inline in italic: <a href="s{n}"><i>{source}</i></a> where {n} is the item's number)`,
    `- End with: — · top pick: <the biggest story title>`,
    `Use only tags <b> <i> <a href="s{n}"> <blockquote>. Hard cap 3500 characters.`,
    `IMPORTANT: link hrefs MUST be exactly href="s{n}" — NEVER write full URLs anywhere in your response. The server replaces s{n} with the real URL.`,
    `Respond ONLY with JSON {"title","post","items":[{"n":1,"title":"..."}]}.`,
    ``,
    `ITEMS:`,
    JSON.stringify(rows.map((r, i) => ({ n: i + 1, ...r }))),
  ].join('\n');
}

/** Extract the first balanced JSON object from raw LLM text. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw.replace(/```json|```/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function digestChat(
  cfg: DigestConfig,
  userPrompt: string,
): Promise<
  { ok: true; raw: string; finishReason?: string } | { ok: false; error: string }
> {
  if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
    return { ok: false, error: 'digest LLM not configured' };
  }
  return chatCompletion(cfg.llm, [
    {
      role: 'system',
      content:
        'You are a professional, concise digest editor. You never invent facts and you always answer with valid JSON only.',
    },
    { role: 'user', content: userPrompt },
  ]);
}

function parseDigestResult(
  raw: string,
  candidates: DigestCandidate[],
): DigestLlmResult | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  let post = typeof obj.post === 'string' ? obj.post.trim() : '';
  if (!title || !post) return null;

  // The model references candidates by number (href="s{n}" + items[].n) and
  // never echoes full URLs — keeps output under the token cap and prevents
  // URL corruption. Resolve the placeholders server-side; unknown refs are
  // unwrapped (their text survives). Legacy full-URL items are still accepted.
  const byN = new Map<number, DigestCandidate>();
  candidates.forEach((c, i) => byN.set(i + 1, c));
  const knownUrl = (url: string) => candidates.some((c) => c.url === url);

  const items: { url: string; title: string }[] = [];
  if (Array.isArray(obj.items)) {
    for (const it of obj.items as { n?: unknown; url?: unknown; title?: unknown }[]) {
      const n = typeof it?.n === 'number' ? it.n : Number(it?.n);
      const url = byN.get(n)?.url ?? (typeof it?.url === 'string' ? it.url : '');
      if (url && knownUrl(url)) {
        items.push({
          url,
          title: typeof it?.title === 'string' ? it.title : '',
        });
      }
    }
  }

  post = post.replace(
    /<a\s+href=["']s(\d+)["']\s*>([\s\S]*?)<\/a>/gi,
    (_m, num: string, text: string) => {
      const c = byN.get(Number(num));
      return c ? `<a href="${c.url}">${text}</a>` : text;
    },
  );

  return { title, post, items };
}


/* ------------------------------------------------------------------ */
/* Slot computation (TIMEZONE-aware)                                   */
/* ------------------------------------------------------------------ */

function localParts(tz: string, now = new Date()): {
  date: string;
  hour: number;
  weekday: number; // 0=Sunday..6=Saturday
  day: number;
} {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const get = (t: string) =>
    dtf.formatToParts(now).find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) || 0,
    weekday: Math.max(0, weekdays.indexOf(get('weekday'))),
    day: Number(get('day')) || 1,
  };
}

/** ISO-8601 week number for a "YYYY-MM-DD" date string. */
function isoWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week =
    1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeSlotKey(
  type: DigestContentType,
  lp: { date: string; hour: number },
  /** Intraday slot tag — appended so same-day slots don't collide. */
  tag?: string,
): string {
  const hh = String(lp.hour).padStart(2, '0');
  if (type === 'weekly') return `weekly-${isoWeek(lp.date)}`;
  if (type === 'monthly') return `monthly-${lp.date.slice(0, 7)}`;
  return tag ? `${lp.date}T${hh}:${tag}` : `${lp.date}T${hh}`;
}

/* ------------------------------------------------------------------ */
/* D1 helpers                                                          */
/* ------------------------------------------------------------------ */


interface SlotRow {
  id: number;
  status: string;
}

async function findSlotRow(
  db: D1Database,
  slotKey: string,
  chatId: string,
): Promise<SlotRow | null> {
  const res = await db
    .prepare('SELECT id, status FROM digest_posts WHERE slot_key = ? AND target_chat_id = ?')
    .bind(slotKey, chatId)
    .first<SlotRow>();
  return res ?? null;
}

async function publishedUrlHashes(db: D1Database): Promise<Set<string>> {
  const res = await db.prepare('SELECT url_hash FROM digest_items LIMIT 20000').all<{
    url_hash: string;
  }>();
  return new Set((res.results ?? []).map((r) => r.url_hash));
}

interface HistoryRow {
  url: string;
  title: string;
  source: string;
  reactions: number | null;
}

async function loadHistory(
  db: D1Database,
  chatId: string,
  days: number,
): Promise<HistoryRow[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT di.url, di.title, di.source,
              (SELECT s.value FROM digest_post_stats s
                WHERE s.digest_post_id = dp.id AND s.metric = 'reactions'
                ORDER BY s.captured_at DESC LIMIT 1) AS reactions
       FROM digest_items di
       JOIN digest_posts dp ON dp.id = di.digest_post_id
       WHERE di.published_at >= ? AND dp.target_chat_id = ?
       ORDER BY reactions DESC, di.published_at DESC
       LIMIT 15`,
    )
    .bind(since, chatId)
    .all<HistoryRow>();
  return res.results ?? [];
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/**
 * RTL line marks: for output languages like Arabic, prepend U+200F (RLM) to
 * every line that contains RTL characters so Telegram renders the paragraph
 * right-to-left even when the line mixes in English titles or URLs. Pure
 * left-to-right lines are left untouched (content-based detection — no
 * language flag needed). Applied after sanitize so drafts, published posts,
 * and the editor preview render identically.
 */
const RTL_CHAR_RE = /[\u0591-\u07FF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

function applyRtlMarks(body: string): string {
  return body
    .split('\n')
    .map((line) => (RTL_CHAR_RE.test(line) ? '\u200F' + line : line))
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Domain rotation (plan §23.1)                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the effective domain for this slot when NEWS_DOMAIN holds a
 * rotation strategy. Both strategies are *slot-deterministic* — the same
 * slot always resolves to the same domain — so a manual retry after a
 * transient failure regenerates the same topic instead of skipping a beat:
 *   round-robin: cursor = count of attempted daily slots % presets
 *   random:      stable hash of the slot key
 * Returns the configured value unchanged for fixed presets.
 */
export async function resolveSlotDomain(
  env: Env,
  db: D1Database,
  slotKey: string,
): Promise<string> {
  const configured = (env.NEWS_DOMAIN || 'tech').trim();
  if (!isRotationDomain(configured)) return configured;
  const presets = ROTATION_PRESETS;
  if ((configured || '').toLowerCase() === 'random') {
    let h = 0;
    for (let i = 0; i < slotKey.length; i++) h = (h * 31 + slotKey.charCodeAt(i)) | 0;
    return presets[Math.abs(h) % presets.length];
  }
  const res = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM digest_posts WHERE type = 'daily'
       AND status IN ('draft','published')`,
    )
    .first<{ c: number }>();
  const attempted = Number(res?.c ?? 0);
  return presets[attempted % presets.length];
}

/** Pin a slot's engines + mode + topic override + LLM token budget onto the
 *  resolved config. Applied before rotation (engines must survive the domain
 *  rebuild) and re-applied after it (resolveDigestConfig resets everything). */
function applySlotOverride(cfg: DigestConfig, slot: SlotConfig): DigestConfig {
  return {
    ...cfg,
    mode: slot.mode,
    newsEngines: slot.newsEngines,
    scholarEngines: slot.scholarEngines,
    ...(slot.topics !== undefined ? { topics: slot.topics } : {}),
    ...(slot.maxTokens !== undefined
      ? { llm: { ...cfg.llm, maxTokens: slot.maxTokens } }
      : {}),
  };
}

/**
 * Deep slot source: today's already-published items, richest-first. Reads the
 * D1 archive instead of gathering — deep content must not re-fetch intraday
 * (cost principle: the full text was already captured at publish time and
 * lives in digest_items.extracted_text). Items without archived text still
 * appear (title/source only) so the LLM can decide what it can responsibly
 * analyze; fabricated detail is forbidden by the prompt.
 */
async function loadDeepSource(
  db: D1Database,
  cfg: DigestConfig,
  date: string,
): Promise<DigestCandidate[]> {
  const res = await db
    .prepare(
      `SELECT di.url, di.title, di.source, di.extracted_text
       FROM digest_items di JOIN digest_posts dp ON di.digest_post_id = dp.id
       WHERE dp.target_chat_id = ? AND dp.status = 'published'
         AND dp.slot_key LIKE ? || 'T%' AND dp.slot_key NOT LIKE '%:deep'
       ORDER BY (di.extracted_text IS NULL), dp.run_at DESC
       LIMIT 10`,
    )
    .bind(
      cfg.targetChatId,
      date,
    )
    .all<{ url: string; title: string; source: string; extracted_text: string | null }>();
  return (res.results ?? []).map((r) => ({
    tag: 'headlines' as const,
    title: r.title,
    url: r.url,
    source: r.source,
    snippet: r.extracted_text ?? undefined,
  }));
}

async function runDigest(
  env: Env,
  cfg: DigestConfig,
  type: DigestContentType,
  logger: AuditLogger,
  /** Intraday slot override — replaces the engines/mode for this run and
   *  tags the slot key so same-day slots don't collide. */
  slot?: SlotConfig,
): Promise<void> {
  const db = env.DB;
  if (!db || !cfg.targetChatId) {
    await logger.error('news_error', { reason: 'digest requires DB and NEWS_TARGET_CHAT_ID' });
    return;
  }
  const lp = localParts(env.TIMEZONE);
  const slotKey = computeSlotKey(type, lp, slot?.tag);
  const now = new Date().toISOString();

  // Intraday slot: pin the engines + mode + token budget to the slot's tag.
  // Applied before rotation so the per-tag engine set survives the domain pick
  // below.
  if (slot) cfg = applySlotOverride(cfg, slot);

  // Rotation: the gate resolves a placeholder cfg; decide this slot's real
  // domain first, then rebuild the config from the effective preset so the
  // topics/engines/locale all match what actually runs. cfg.effectiveDomain
  // (not cfg.domain) is what gets stored in digest_posts.domain. Re-apply the
  // slot engine/mode override afterwards since resolveDigestConfig rebuilds them.
  if (cfg.rotation) {
    const picked = await resolveSlotDomain(env, db, slotKey);
    cfg = resolveDigestConfig(env, picked);
    if (slot) cfg = applySlotOverride(cfg, slot);
  }

  // Idempotency: same slot + chat already attempted → no-op.
  const existing = await findSlotRow(db, slotKey, cfg.targetChatId);
  if (existing) {
    await logger.debug('news_skipped', {
      chat_id: Number(cfg.targetChatId),
      decision: 'skip',
      reason: `already_${existing.status}`,
      extra: { slot: slotKey, type },
    });
    return;
  }

  await logger.debug('news_run_started', {
    chat_id: Number(cfg.targetChatId),
    extra: { slot: slotKey, type, domain: cfg.effectiveDomain, mode: cfg.mode },
  });

  // Gather: fresh engines, or D1 history for weekly/monthly.
  let candidates: DigestCandidate[] = [];
  let historyCandidates: DigestCandidate[] = [];
  let prompt = '';
  // Raw engine/extraction text per URL, captured verbatim before the LLM sees
  // the candidates. Populated only when NEWS_FETCH_FULLTEXT drives an extract;
  // looked up when archiving selected items in digest_items.extracted_text.
  const extractedByUrl = new Map<string, string>();
  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    if (type !== 'daily') {
      const rows = await loadHistory(
        db,
        cfg.targetChatId,
        type === 'weekly' ? 7 : 30,
      );
      historyCandidates = rows.map((r) => ({
        tag: 'headlines' as const,
        title: r.title,
        url: r.url,
        source: r.source,
      }));
      if (rows.length >= 3) {
        prompt = buildHistoryPrompt(
          cfg,
          type,
          rows.map((r) => ({
            title: r.title,
            url: r.url,
            source: r.source,
            reactions: r.reactions,
          })),
        );
      } else {
        historyCandidates = [];
      }
    }
    if (slot?.tag === 'deep') {
      // Deep-dive slot: analyze today's already-published items from the D1
      // archive (richest extracted_text first). No engines, no fetching, no
      // dedupe pass — everything here is already in the registry by
      // construction, and re-inserting hits INSERT OR IGNORE (no-op).
      candidates = await loadDeepSource(db, cfg, lp.date);
      if (!candidates.length) {
        await logger.info('news_skipped', {
          chat_id: Number(cfg.targetChatId),
          decision: 'skip',
          reason: 'deep_no_source',
          extra: { slot: slotKey, type },
        });
        return;
      }
      prompt = buildDeepPrompt(cfg, candidates);
    } else if (!prompt) {
      candidates = await gatherSources(cfg);
      if (!candidates.length) {
        await logger.warn('news_skipped', {
          chat_id: Number(cfg.targetChatId),
          decision: 'skip',
          reason: 'no_candidates',
          extra: { slot: slotKey, type },
        });
        return;
      }
      // Cross-run URL dedupe: never re-post an item.
      const seen = await publishedUrlHashes(db);
      const fresh = [] as DigestCandidate[];
      for (const c of candidates) {
        const h = await sha256Hex(normalizeUrl(c.url));
        if (!seen.has(h)) fresh.push(c);
      }
      candidates = fresh;
      if (!candidates.length) {
        await logger.info('news_skipped', {
          chat_id: Number(cfg.targetChatId),
          decision: 'skip',
          reason: 'all_items_seen',
          extra: { slot: slotKey, type },
        });
        return;
      }
      // Optional full-text for the top few (NEWS_FETCH_FULLTEXT). Extraction
      // routes by content type, cheapest-first: HTML → local HTMLRewriter →
      // Jina Reader; PDF → Jina Reader → LlamaParse. Never pay for what we
      // already have (≥200-char snippets skip) and never exceed the per-run
      // cap (NEWS_EXTRACT_MAX_PER_RUN) — more slots must not scale credits.
      if (cfg.fetchFulltext) {
        for (const c of candidates.slice(0, cfg.extractMax)) {
          if (c.snippet && c.snippet.length >= 200) continue;
          try {
            const isPdf = /\.pdf(\?|$)/i.test(c.url);
            if (isPdf) {
              // Native fetch+HTMLRewriter is useless on PDFs; Jina reads them
              // natively, LlamaParse is the deep fallback (1 credit/page).
              c.snippet = (await extractViaJina(cfg, c.url)) || c.snippet;
              if ((!c.snippet || c.snippet.length < 120) && cfg.llamaKey) {
                c.snippet = (await extractViaLlamaParse(cfg, c.url)) || c.snippet;
              }
            } else {
              const res = await fetchWithTimeout(c.url, {}, 10_000);
              if (res.ok) {
                const html = await res.text();
                c.snippet = await extractArticleText(html);
              }
              if ((!c.snippet || c.snippet.length < 120) && cfg.jinaKey) {
                c.snippet = (await extractViaJina(cfg, c.url)) || c.snippet;
              }
            }
          } catch {
            // extraction failure — summarize from snippet/title
          }
          // Remember the raw (post-extraction) text verbatim before the LLM
          // sees it — this is what gets archived in digest_items.extracted_text.
          if (c.snippet) extractedByUrl.set(c.url, c.snippet);
        }
      }
      prompt = buildDailyPrompt(cfg, candidates);
    }
  }

  // One LLM call: select + summarize + translate + format.
  const llm = await digestChat(cfg, prompt);
  if (!llm.ok) {
    await logger.error('news_error', {
      chat_id: Number(cfg.targetChatId),
      reason: llm.error,
      extra: { slot: slotKey, type },
    });
    return;
  }
  const parsed = parseDigestResult(
    llm.raw,
    candidates.length ? candidates : historyCandidates,
  );
  if (!parsed || !parsed.post) {
    await logger.error('news_error', {
      chat_id: Number(cfg.targetChatId),
      reason: `unparseable_digest${llm.finishReason ? ` (finish=${llm.finishReason})` : ''}`,
      llm_response: llm.raw.slice(0, 1200),
      extra: {
        slot: slotKey,
        type,
        // Cap the stored raw (audit-details panels render this) — the full
        // text stays in the worker logs / truncated marker tells you.
        raw: llm.raw.slice(0, 1200) + (llm.raw.length > 1200 ? '…' : ''),
      },
    });
    return;
  }

  // Sanitize + sponsor footer (appended post-sanitize, never LLM-generated).
  // RTL marks last: every stored/rendered form of the body is consistent.
  let body = applyRtlMarks(sanitizeTelegramHtml(parsed.post));
  if (cfg.sponsorText) {
    const sponsor = cfg.sponsorText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    body += `\n\n<i>${sponsor}</i>`;
  }

  const provider = cfg.llm.baseUrl;
  const insert = await db
    .prepare(
      `INSERT INTO digest_posts
         (slot_key, type, run_at, mode, domain, target_chat_id,
          title, body, body_original, status, provider, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .bind(
      slotKey,
      type,
      now,
      cfg.mode,
      cfg.effectiveDomain,
      cfg.targetChatId,
      parsed.title,
      body,
      body,
      provider,
      cfg.llm.model,
    )
    .run();
  const postId = insert.meta.last_row_id as number | undefined;

  // Record items (dedupe by URL hash across runs). When full-text was fetched,
  // archive the raw extracted text verbatim — powers future re-summarize /
  // source-Q&A features without re-fetching. NULL otherwise (rollup items have
  // no source text; non-fulltext runs didn't extract any).
  for (const it of parsed.items) {
    const h = await sha256Hex(normalizeUrl(it.url));
    await db
      .prepare(
        `INSERT OR IGNORE INTO digest_items
           (url_hash, url, title, source, digest_post_id, extracted_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        h,
        it.url,
        it.title.slice(0, 300),
        domainOf(it.url) || 'digest',
        postId ?? null,
        extractedByUrl.get(it.url) ?? null,
      )
      .run();
  }

  if (!cfg.autoPublish) {
    await logger.info('news_draft_created', {
      chat_id: Number(cfg.targetChatId),
      extra: { slot: slotKey, type, postId, title: parsed.title },
    });
    const target = env.NEWS_DRAFT_NOTIFY_CHAT_ID?.trim() || null;
    const noticeText = `📝 <b>Digest draft ready for review</b>\nSlot: <code>${slotKey}</code>\n${parsed.title}`;
    if (target) {
      await sendMessageDetailed(env, target, noticeText, {
        parseMode: 'HTML',
        disablePreview: true,
      });
    } else {
      await notifyAdmins(env, noticeText);
    }
    return;
  }

  // Auto-publish path.
  const sent: SendResult = await sendMessageDetailed(
    env,
    Number(cfg.targetChatId),
    body,
    { parseMode: 'HTML', disablePreview: true },
  );
  if (sent.ok && sent.messageId) {
    await db
      .prepare(
        `UPDATE digest_posts SET status='published', message_id=?, published_at=?, error=NULL WHERE id=?`,
      )
      .bind(sent.messageId, new Date().toISOString(), postId)
      .run();
    await db
      .prepare(`UPDATE digest_items SET published_at=? WHERE digest_post_id=?`)
      .bind(new Date().toISOString(), postId)
      .run();
    await logger.info('news_published', {
      chat_id: Number(cfg.targetChatId),
      decision: 'publish',
      reason: type,
      extra: { slot: slotKey, type, postId, messageId: sent.messageId },
    });
  } else {
    await db
      .prepare(`UPDATE digest_posts SET status='failed', error=? WHERE id=?`)
      .bind(sent.description ?? 'send_failed', postId)
      .run();
    await logger.error('news_error', {
      chat_id: Number(cfg.targetChatId),
      reason: `send_failed: ${sent.description ?? ''}`,
      extra: { slot: slotKey, type, postId },
    });
    await notifyAdmins(
      env,
      `⚠️ Digest publish FAILED for slot <code>${slotKey}</code>: ${sent.description ?? 'unknown'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Cron gate                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hourly gate: resolves the current local time (TIMEZONE) into a content
 * type and runs the pipeline for the matching slot.
 *
 * Priority when several types match (avoids triple-posting):
 *   monthly > weekly > intraday-schedule > legacy daily.
 *
 * Intraday schedule (NEWS_SCHEDULE) is the preferred driver: each slot pins
 * its own engines + mode via a SlotConfig and tags its slot key, so a single
 * day can run e.g. headlines @09, papers @14, trending @20 without colliding.
 * When NEWS_SCHEDULE is unset, the legacy NEWS_PUBLISH_HOURS daily behavior
 * is preserved for backward compatibility.
 */
export async function runDigestGate(env: Env): Promise<void> {
  if ((env.ENABLE_NEWS_DIGEST || '').trim().toLowerCase() !== 'true') return;
  const logger = makeLoggerFor(env);
  const cfg = resolveDigestConfig(env);
  const lp = localParts(env.TIMEZONE);

  // NEWS_SCHEDULE is the single source of digest timing. Without it there is
  // nothing to run — log a warning (once per day, on the first hourly
  // invocation) so a misconfigured deployment is never silent.
  if (!hasSchedule(env)) {
    if (lp.hour === 0) {
      await logger.warn('news_config_warning', {
        chat_id: Number(cfg.targetChatId) || null,
        reason: 'NEWS_SCHEDULE unset — digest disabled',
      });
    }
    return;
  }
  const schedule = parseSchedule(env.NEWS_SCHEDULE);
  // Weekly/monthly rollups fire at the earliest scheduled hour (morning
  // roundup) — replaces the removed NEWS_PUBLISH_HOURS.
  const rollupHour = rollupHourFromSchedule(schedule);

  let type: DigestContentType | null = null;
  let slot: SlotConfig | undefined;

  if (
    cfg.monthlyEnabled &&
    lp.day === cfg.monthlyDay &&
    lp.hour === rollupHour
  ) {
    type = 'monthly';
  } else if (
    cfg.weeklyEnabled &&
    lp.weekday === cfg.weeklyDay &&
    lp.hour === rollupHour
  ) {
    type = 'weekly';
  } else {
    const scheduled = schedule[lp.hour];
    if (scheduled) {
      type = 'daily';
      slot = scheduled;
    }
  }
  if (!type) return;

  try {
    await runDigest(env, cfg, type, logger, slot);
  } catch (err) {
    await logger.error('news_error', {
      chat_id: Number(cfg.targetChatId) || null,
      reason: `gate:${String(err).slice(0, 300)}`,
      extra: { type, slot: slot?.tag },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Reaction capture (analytics foundation, plan §12)                   */
/* ------------------------------------------------------------------ */

interface ReactionCountUpdate {
  chat?: { id?: number };
  message_id?: number;
  reactions?: { type?: { type?: string; emoji?: string }; total_count?: number }[];
}

/**
 * Handle update.message_reaction_count (anonymous channel reactions — the
 * default in channels). update.message_reaction carries per-user deltas
 * without totals, so it is deliberately ignored here (plan §12).
 */
export async function captureReactionUpdate(
  env: Env,
  update: { message_reaction_count?: ReactionCountUpdate },
  logger: AuditLogger,
): Promise<void> {
  if ((env.ENABLE_POST_ANALYTICS || '').trim() !== 'true') return;
  const u = update.message_reaction_count;
  if (!u?.chat?.id || !u.message_id || !env.DB) return;
  const detail: Record<string, number> = {};
  let total = 0;
  for (const r of u.reactions ?? []) {
    const emoji = r.type?.emoji;
    const count = r.total_count ?? 0;
    if (emoji && count > 0) {
      detail[emoji] = count;
      total += count;
    }
  }
  try {
    const post = await env.DB
      .prepare(
        `SELECT id FROM digest_posts WHERE message_id = ? AND target_chat_id = ? AND status='published'`,
      )
      .bind(u.message_id, String(u.chat.id))
      .first<{ id: number }>();
    if (!post) return;
    const detailJson = JSON.stringify(detail);
    const last = await env.DB
      .prepare(
        `SELECT detail_json FROM digest_post_stats
         WHERE digest_post_id = ? AND metric='reactions'
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .bind(post.id)
      .first<{ detail_json: string }>();
    if (last?.detail_json === detailJson) return; // change-gated write
    await env.DB
      .prepare(
        `INSERT INTO digest_post_stats (digest_post_id, metric, value, detail_json, captured_at)
         VALUES (?, 'reactions', ?, ?, ?)`,
      )
      .bind(post.id, total, detailJson, new Date().toISOString())
      .run();
    await logger.debug('news_stats_captured', {
      chat_id: u.chat.id,
      extra: { messageId: u.message_id, total },
    });
  } catch (err) {
    await logger.debug('news_stats_error', { reason: String(err).slice(0, 200) });
  }
}

/* ------------------------------------------------------------------ */
/* Retention prune (rides the daily 04:00 UTC cron)                    */
/* ------------------------------------------------------------------ */

export async function pruneDigests(env: Env): Promise<void> {
  if (!env.DB) return;
  const cfg = resolveDigestConfig(env);
  const draftCutoff = new Date(
    Date.now() - cfg.draftTtlDays * 24 * 3600 * 1000,
  ).toISOString();
  const rowCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const statsCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  try {
    await env.DB
      .prepare(
        `UPDATE digest_posts SET status='discarded'
         WHERE status='draft' AND run_at < ?`,
      )
      .bind(draftCutoff)
      .run();
    await env.DB.prepare(
      `DELETE FROM digest_posts WHERE status IN ('failed','discarded') AND run_at < ?`,
    )
      .bind(rowCutoff)
      .run();
    await env.DB.prepare(`DELETE FROM digest_post_stats WHERE captured_at < ?`)
      .bind(statsCutoff)
      .run();
  } catch (err) {
    console.error(`digest prune failed: ${err}`);
  }

  // Daily channel-member snapshot (analytics media-kit series, plan §12).
  if (cfg.postAnalytics && cfg.targetChatId) {
    try {
      const count = await getChatMemberCount(env, cfg.targetChatId);
      if (count != null) {
        const last = await env.DB.prepare(
          `SELECT value FROM digest_post_stats
           WHERE metric='channel_members' ORDER BY captured_at DESC LIMIT 1`,
        ).first<{ value: number }>();
        if (last?.value !== count) {
          await env.DB.prepare(
            `INSERT INTO digest_post_stats (digest_post_id, metric, value, detail_json, captured_at)
             VALUES (NULL, 'channel_members', ?, NULL, ?)`,
          )
            .bind(count, new Date().toISOString())
            .run();
        }
      }
    } catch (err) {
      console.error(`member snapshot failed: ${err}`);
    }
  }
}

/* Local logger factory (thin alias so callers below read cleanly). */
function makeLoggerFor(env: Env): AuditLogger {
  return makeLogger(env);
}

