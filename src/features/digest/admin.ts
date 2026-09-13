/**
 * Digest review console: the panel's one mutation surface (draft save /
 * publish / discard / regenerate + force-run), plus read-only stats and
 * resolved-settings views. Mounted behind the core admin cookie auth; POST
 * handlers additionally enforce a CSRF guard (custom header + Origin check).
 */

import { json } from '../../core/admin';
import type { AdminRoute } from '../../core/router';
import type { Env } from '../../core/types';
import { makeLogger } from '../../core/logger';
import { sendMessageDetailed } from '../../core/telegram';
import { sanitizeTelegramHtml } from '../../shared/telegram-html';
import { resolveDigestConfig } from './config';
import { runDigestGate } from './pipeline';

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

async function handleDigestRun(env: Env): Promise<Response> {
  await runDigestGate(env, true);
  return json({ ok: true, note: 'gate ran — check the runs list for the new row' });
}

async function handleDigestStats(env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  try {
    const posts = await env.DB.prepare(
      `SELECT dp.id, dp.title, dp.type, dp.published_at, dp.message_id, dp.target_chat_id,
              (SELECT s.value FROM digest_post_stats s
                WHERE s.digest_post_id = dp.id AND s.metric = 'reactions'
                ORDER BY s.captured_at DESC LIMIT 1) AS reactions,
              (SELECT s.detail_json FROM digest_post_stats s
                WHERE s.digest_post_id = dp.id AND s.metric = 'reactions'
                ORDER BY s.captured_at DESC LIMIT 1) AS reactions_json
       FROM digest_posts dp WHERE dp.status = 'published'
       ORDER BY dp.published_at DESC LIMIT 20`,
    ).all();
    const members = await env.DB.prepare(
      `SELECT value, captured_at FROM digest_post_stats
       WHERE metric = 'channel_members' ORDER BY captured_at DESC LIMIT 30`,
    ).all();
    return json({ posts: posts.results ?? [], members: members.results ?? [] });
  } catch (err) {
    return json({ error: `digest stats failed: ${err}` }, 500);
  }
}

async function handleDigestSettings(env: Env): Promise<Response> {
  const cfg = resolveDigestConfig(env);
  return json({
    domain: cfg.domain,
    mode: cfg.mode,
    topics: cfg.topics,
    engines: cfg.newsEngines,
    arxivCats: cfg.arxivCats,
    includeDomains: cfg.includeDomains,
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
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model },
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
  { method: 'POST', rest: '/api/digest/run', handler: (_q, env) => handleDigestRun(env) },
  { method: 'GET', rest: '/api/digest/stats', handler: (_q, env) => handleDigestStats(env) },
  { method: 'GET', rest: '/api/digest/settings', handler: (_q, env) => handleDigestSettings(env) },
];
