/**
 * Digest review console: the panel's mutation surface (draft save / publish /
 * discard, dev-seed), plus read-only stats and resolved-settings views.
 * Mounted behind the core admin cookie auth; POST handlers additionally enforce
 * a CSRF guard (custom header + Origin check).
 */

import { json } from '../../core/admin';
import type { AdminRoute } from '../../core/router';
import type { Env } from '../../core/types';
import { makeLogger } from '../../core/logger';
import { sendMessageDetailed } from '../../core/telegram';
import { sanitizeTelegramHtml } from '../../shared/telegram-html';
import { domainOf, normalizeUrl, sha256Hex } from '../../shared/sources';
import {
  resolveDigestConfig,
  parseReactionSignals,
  isRotationDomain,
  parseSchedule,
  isSeedEnabled,
} from './config';
import { loadPostAnalytics } from './analytics';
import type { PostAnalytics } from './analytics';

/* CSRF guard for the digest mutation endpoints                        */
/* ------------------------------------------------------------------ */

/**
 * Digest POSTs require: (1) the X-Requested-With: fetch header (a cross-site
 * HTML form cannot set custom headers) and (2) an Origin header whose host
 * matches the request host. SameSite=Strict on the auth cookie is the third
 * layer (FEATURE_PLAN.md §11.4 / §16).
 */
function csrfOk(request: Request): boolean {
  if ((request.headers.get('X-Requested-With') || '') !== 'fetch') return false;
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Digest handlers                                                     */
/* ------------------------------------------------------------------ */

interface DigestListRow {
  id: number;
  slot_key: string;
  type: string;
  run_at: string;
  mode: string;
  domain: string | null;
  target_chat_id: string;
  title: string | null;
  preview: string | null;
  body_len: number;
  status: string;
  provider: string | null;
  model: string | null;
  edited_at: string | null;
  published_at: string | null;
  message_id: number | null;
  error: string | null;
}

async function handleDigestList(env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  try {
    const rows = await env.DB.prepare(
      `SELECT id, slot_key, type, run_at, mode, domain, target_chat_id, title,
              substr(body, 1, 220) AS preview, length(body) AS body_len,
              status, provider, model, edited_at, published_at, message_id, error
       FROM digest_posts ORDER BY run_at DESC LIMIT 50`,
    ).all<DigestListRow>();
    return json({
      auto_publish: (env.NEWS_AUTO_PUBLISH || '').trim().toLowerCase() === 'true',
      enabled: (env.ENABLE_NEWS_DIGEST || '').trim().toLowerCase() === 'true',
      rows: rows.results ?? [],
    });
  } catch (err) {
    return json({ error: `digest list failed: ${err}` }, 500);
  }
}

async function handleDigestOne(env: Env, id: number): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const row = await env.DB.prepare(
    `SELECT id, slot_key, type, run_at, mode, domain, target_chat_id, title,
            body, body_original, status, provider, model, edited_at,
            published_at, message_id, error
     FROM digest_posts WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json(row);
}

/**
 * Draft actions: save (persist edits), publish (sanitize + send), discard.
 * Only drafts are mutable — a published/discarded/failed row is final here.
 */
async function handleDigestAction(
  env: Env,
  id: number,
  action: 'save' | 'publish' | 'discard',
  request: Request,
): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const logger = makeLogger(env);
  const row = await env.DB.prepare(
    `SELECT id, slot_key, type, title, body, status, target_chat_id, body_original
     FROM digest_posts WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: number;
      slot_key: string;
      type: string;
      title: string | null;
      body: string;
      status: string;
      target_chat_id: string;
      body_original: string | null;
    }>();
  if (!row) return json({ error: 'Not found' }, 404);
  if (row.status !== 'draft') {
    return json({ error: `Row is ${row.status}; only drafts are mutable` }, 409);
  }

  if (action === 'save') {
    let payload: { body?: unknown } = {};
    try {
      payload = (await request.json()) as { body?: unknown };
    } catch {
      return json({ error: 'Bad request' }, 400);
    }
    if (typeof payload.body !== 'string' || !payload.body.trim()) {
      return json({ error: 'body required' }, 400);
    }
    if (payload.body.length > 20_000) return json({ error: 'body too long' }, 400);
    await env.DB.prepare(
      `UPDATE digest_posts SET body = ?, edited_at = ? WHERE id = ? AND status = 'draft'`,
    )
      .bind(payload.body, new Date().toISOString(), id)
      .run();
    return json({ ok: true, action: 'save' });
  }

  if (action === 'discard') {
    await env.DB.prepare(
      `UPDATE digest_posts SET status = 'discarded' WHERE id = ? AND status = 'draft'`,
    )
      .bind(id)
      .run();
    await logger.info('news_draft_discarded', {
      chat_id: Number(row.target_chat_id) || null,
      extra: { postId: id, slot: row.slot_key },
    });
    return json({ ok: true, action: 'discard' });
  }

  // publish
  let sponsorSuffix = '';
  if (env.NEWS_SPONSOR_TEXT?.trim()) {
    sponsorSuffix =
      '\n\n<i>' +
      env.NEWS_SPONSOR_TEXT.trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;') +
      '</i>';
  }
  const clean = sanitizeTelegramHtml(row.body, 7900) + sponsorSuffix;
  const sent = await sendMessageDetailed(
    env,
    /^\d+$/.test(row.target_chat_id) ? Number(row.target_chat_id) : row.target_chat_id,
    clean,
    { parseMode: 'HTML', disablePreview: true },
  );
  if (sent.ok && sent.messageId) {
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE digest_posts SET status='published', message_id=?, published_at=?, error=NULL,
              body=? WHERE id=?`,
    )
      .bind(sent.messageId, nowIso, clean, id)
      .run();
    await env.DB.prepare(
      `UPDATE digest_items SET published_at=? WHERE digest_post_id=? AND published_at IS NULL`,
    )
      .bind(nowIso, id)
      .run();
    await logger.info('news_published', {
      chat_id: Number(row.target_chat_id) || null,
      decision: 'publish',
      reason: 'admin_publish',
      extra: { postId: id, slot: row.slot_key, messageId: sent.messageId },
    });
    return json({ ok: true, action: 'publish', message_id: sent.messageId });
  }
  await env.DB.prepare(`UPDATE digest_posts SET status='failed', error=? WHERE id=?`)
    .bind(sent.description ?? 'send_failed', id)
    .run();
  await logger.error('news_error', {
    chat_id: Number(row.target_chat_id) || null,
    reason: `admin_publish_failed: ${sent.description ?? ''}`,
    extra: { postId: id, slot: row.slot_key },
  });
  return json({ ok: false, error: sent.description ?? 'send_failed' }, 502);
}

/**
 * Dev-only: insert a realistic fake draft so the review/edit/publish/discard
 * workflow can be exercised end-to-end without triggering the pipeline. Gated
 * behind ENABLE_NEWS_DIGEST + the (gitignored) NEWS_DEV_SEED toggle so it can
 * never run in production. Idempotent per call — each click makes a new draft.
 */
async function handleDigestSeed(env: Env): Promise<Response> {
  if (!isSeedEnabled(env.NEWS_DEV_SEED)) {
    return json({ error: 'Seed disabled (set NEWS_DEV_SEED=true to enable)' }, 404);
  }
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const cfg = resolveDigestConfig(env);
  if (!cfg.targetChatId) {
    return json({ error: 'NEWS_TARGET_CHAT_ID required to seed a draft' }, 400);
  }
  const slot = `dev-seed-${Date.now()}`;
  const title = '[dev] Sample digest — ملخص تجريبي';
  const body = [
    '📰 <b>مراجعة الذكاء الاصطناعي — ملخص تجريبي</b>',
    '',
    '• <b>نموذج لغوي جديد يُحسن الاستدلال متعدد الخطوات</b> — ملخص موجز من سطرين يلخّص التحسين المُعلن مع الحفاظ على الحقائق ودون مبالغة، ويُظهر كيف تبدو بطاقة الخبر داخل المسودة.',
    '<a href="s1">المصدر</a>',
    '',
    '• <b>ورقة روبوتات: تعلّم المحاكاة إلى العالم الحقيقي</b> — نقل السياسات من المحاكاة إلى الواقع مع تقليل الفجوة بنسبة ملحوظة على مهام الإمساك الدقيق.',
    '<a href="s2">arXiv</a>',
    '',
    '— · مصادر تجريبية',
  ].join('\n');

  const insert = await env.DB
    .prepare(
      `INSERT INTO digest_posts
         (slot_key, type, run_at, mode, domain, target_chat_id,
          title, body, body_original, status, provider, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .bind(
      slot,
      'daily',
      new Date().toISOString(),
      cfg.mode,
      cfg.effectiveDomain,
      cfg.targetChatId,
      title,
      body,
      body,
      cfg.llm.baseUrl,
      cfg.llm.model,
    )
    .run();
  const postId = insert.meta.last_row_id as number | undefined;

  // A couple of placeholder items so the draft has source rows too.
  const items = [
    { url: 'https://example.com/ai-reasoning', title: 'نموذج لغوي جديد يُحسن الاستدلال' },
    { url: 'https://arxiv.org/abs/2026.00000', title: 'ورقة روبوتات: محاكاة إلى عالم حقيقي' },
  ];
  for (const it of items) {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO digest_items (url_hash, url, title, source, digest_post_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(sha256Hex(normalizeUrl(it.url)), it.url, it.title.slice(0, 300), domainOf(it.url) || 'example.com', postId ?? null)
      .run();
  }

  return json({ ok: true, id: postId, slot_key: slot });
}

/**
 * Published-posts view with the Digest filter bar (plan §23.2): domain /
 * type / date range / status / min reactions / trend — all server-side.
 * Trend and min_reactions depend on presentation-time analytics, so the
 * scan window (200 latest) is fetched, decorated, filtered, then paginated.
 */
async function handleDigestStats(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const url = new URL(request.url);
  const q = url.searchParams;
  try {
    const conds: string[] = [`dp.status = 'published'`];
    const binds: (string | number)[] = [];
    const domain = (q.get('domain') || '').trim().toLowerCase();
    if (domain && domain !== 'all' && /^[a-z0-9-]+$/.test(domain)) {
      conds.push('dp.domain = ?');
      binds.push(domain);
    }
    const type = (q.get('type') || '').trim();
    if (type === 'daily' || type === 'weekly' || type === 'monthly') {
      conds.push('dp.type = ?');
      binds.push(type);
    }
    const from = (q.get('from') || '').trim();
    if (from && !Number.isNaN(Date.parse(from))) {
      conds.push('dp.published_at >= ?');
      binds.push(new Date(from).toISOString());
    }
    const to = (q.get('to') || '').trim();
    if (to && !Number.isNaN(Date.parse(to))) {
      // A bare date means "through the end of that day".
      const endIso = /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? `${to}T23:59:59.999Z`
        : new Date(to).toISOString();
      conds.push('dp.published_at <= ?');
      binds.push(endIso);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const scan = await env.DB.prepare(
      `SELECT dp.id, dp.title, dp.type, dp.domain, dp.published_at,
              dp.message_id, dp.target_chat_id, dp.edited_at, dp.body
       FROM digest_posts dp ${where}
       ORDER BY dp.published_at DESC LIMIT 200`,
    )
      .bind(...binds)
      .all<{
        id: number;
        title: string | null;
        type: string;
        domain: string | null;
        published_at: string | null;
        message_id: number | null;
        target_chat_id: string;
        edited_at: string | null;
        body: string | null;
      }>();
    const rows = scan.results ?? [];

    const cfg = resolveDigestConfig(env);
    const signals = parseReactionSignals(env.NEWS_REACTION_SIGNALS);
    const analytics = await loadPostAnalytics(env.DB, rows, signals);

    // Presentation-time filters (need computed analytics).
    const minRx = minReactionsValue(q);
    const trendFilter = (q.get('trend') || '').trim();
    const kept = rows.filter((r) => {
      const a = analytics.get(r.id) ?? null;
      if (minRx > 0 && (a?.total ?? 0) < minRx) return false;
      if (trendFilter && trendFilter !== 'all' && a?.trend !== trendFilter) {
        return false;
      }
      return true;
    });

    const page = Math.max(1, Number(q.get('page')) || 1);
    const perPage = Math.min(100, Math.max(1, Number(q.get('per_page')) || 20));
    const slice = kept.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

    const posts = slice.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      domain: r.domain,
      published_at: r.published_at,
      message_id: r.message_id,
      target_chat_id: r.target_chat_id,
      edited_at: r.edited_at,
      body_len: (r.body || '').length,
      analytics: analytics.get(r.id) ?? null,
    }));

    // Summary over the whole filtered set (not just the page).
    let sumRx = 0;
    let sumPos = 0;
    let sumNeg = 0;
    let best: { title: string | null; reactions: number } | null = null;
    for (const r of kept) {
      const a = analytics.get(r.id);
      if (!a) continue;
      sumRx += a.total ?? 0;
      sumPos += a.pos;
      sumNeg += a.neg;
      if (!best || (a.total ?? 0) > best.reactions) {
        best = { title: r.title, reactions: a.total ?? 0 };
      }
    }

    const domainRows = await env.DB.prepare(
      `SELECT DISTINCT domain FROM digest_posts
       WHERE domain IS NOT NULL AND status = 'published' ORDER BY domain`,
    ).all<{ domain: string }>();

    return json({
      posts,
      total: kept.length,
      page,
      per_page: perPage,
      has_more: page * perPage < kept.length,
      summary: {
        published: kept.length,
        reactions: sumRx,
        pos: sumPos,
        neg: sumNeg,
        best,
      },
      domains: (domainRows.results ?? []).map((r) => r.domain),
      signal_map: signals,
    });
  } catch (err) {
    return json({ error: `digest stats failed: ${err}` }, 500);
  }
}

/** min_reactions param (empty/invalid/<=0 → 0 = no filter). */
function minReactionsValue(q: URLSearchParams): number {
  const n = Number((q.get('min_reactions') || '0').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function handleDigestSettings(env: Env): Promise<Response> {
  const cfg = resolveDigestConfig(env);
  const signals = parseReactionSignals(env.NEWS_REACTION_SIGNALS);
  const rotating = isRotationDomain(cfg.domain);
  return json({
    domain: cfg.domain,
    // Under rotation the per-domain fields depend on the slot's pick — show
    // the strategy instead of misleading placeholder-preset values.
    rotation: rotating
      ? {
          strategy: cfg.rotation?.strategy ?? 'round-robin',
          presets: cfg.rotation?.presets ?? [],
        }
      : null,
    mode: cfg.mode,
    topics: rotating ? null : cfg.topics,
    engines: rotating ? null : cfg.newsEngines,
    arxivCats: rotating ? null : cfg.arxivCats,
    includeDomains: rotating ? null : cfg.includeDomains,
    maxItems: cfg.maxItems,
    fetchFulltext: cfg.fetchFulltext,
    targetChatId: cfg.targetChatId,
    publishHours: cfg.publishHours,
    weeklyEnabled: cfg.weeklyEnabled,
    monthlyEnabled: cfg.monthlyEnabled,
    language: cfg.language,
    dialect: cfg.dialect ?? null,
    autoPublish: cfg.autoPublish,
    postAnalytics: cfg.postAnalytics,
    sponsor: cfg.sponsorText ?? null,
    reactionSignals: signals,
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model },
    // Intraday schedule as configured (server authoritative). Empty object
    // when NEWS_SCHEDULE is unset — the panel falls back to publishHours.
    schedule: parseSchedule(env.NEWS_SCHEDULE),
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Route table                                                         */
/* ------------------------------------------------------------------ */

/** GET/POST /api/digest/drafts[/:id[/:action]] — list, load, save, publish, discard. */
async function handleDraftsRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const base = env.ADMIN_PANEL_PATH || '/admin';
  const rest = url.pathname.slice(base.length);

  if (request.method === 'GET' && rest === '/api/digest/drafts') {
    return handleDigestList(env);
  }
  const actionMatch = new RegExp(
    '^/api/digest/drafts/(\d+)/(save|publish|discard)$',
  ).exec(rest);
  if (actionMatch) {
    if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
    return handleDigestAction(
      env,
      Number(actionMatch[1]),
      actionMatch[2] as 'save' | 'publish' | 'discard',
      request,
    );
  }
  const oneMatch = new RegExp('^/api/digest/drafts/(\d+)$').exec(rest);
  if (oneMatch) {
    return handleDigestOne(env, Number(oneMatch[1]));
  }
  return json({ error: 'Not found' }, 404);
}

export const digestAdminRoutes: AdminRoute[] = [
  { method: 'GET', prefix: '/api/digest/drafts', handler: handleDraftsRoute },
  // Dev-only seed (NEWS_DEV_SEED=true): insert a fake draft to exercise the
  // review/edit/publish/discard workflow without running the pipeline.
  {
    method: 'POST',
    rest: '/api/digest/dev/seed',
    handler: async (request, env) => {
      if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
      return handleDigestSeed(env);
    },
  },
  { method: 'GET', rest: '/api/digest/stats', handler: (request, env) => handleDigestStats(request, env) },
  { method: 'GET', rest: '/api/digest/settings', handler: (_q, env) => handleDigestSettings(env) },
];
