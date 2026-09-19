/**
 * Digest review console: the panel's mutation surface (draft save / publish /
 * discard, dev-seed), plus read-only stats and resolved-settings views.
 * Mounted behind the core admin cookie auth; POST handlers additionally enforce
 * a CSRF guard (custom header + Origin check).
 */

import { csrfOk, json } from '../../core/admin';
import { loadSettingOverrides } from '../../core/settings';
import type { AdminRoute } from '../../core/router';
import type { Env } from '../../core/types';
import { makeLogger } from '../../core/logger';
import { sendMessageDetailed } from '../../core/telegram';
import { sanitizeTelegramHtml } from '../../shared/telegram-html';
import {
  resolveDigestConfig,
  resolveDigestEnabled,
  DIGEST_DEEP_BODY_LIMIT,
  parseReactionSignals,
  isRotationDomain,
  parseSchedule,
  isSeedEnabled,
  parseDraftsPath,
  rollupHourFromSchedule,
  effectiveSchedule,
} from './config';
import type { SlotTag } from './config';
import { runDigestFromHour, localParts, resolveDigestType, computeSlotKey, applyRtlMarks } from './pipeline';
import { loadPostAnalytics } from './analytics';
import type { PostAnalytics } from './analytics';

/* CSRF: state-changing digest endpoints use the shared core guard
 * (Origin/Referer host match). A previous local copy additionally required
 * X-Requested-With — dropped in favor of the single documented contract;
 * the panel sends same-origin fetches either way. */

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
  // Header toggles resolve through the same layer as the gate/pipeline —
  // env-only values went stale the moment Settings shadowed them
  // (review 1, P1-6). autoPublish comes from the resolved config (single
  // source with the pipeline); enabled shares the gate's helper.
  const overrides = await loadSettingOverrides(env.DB);
  const cfg = resolveDigestConfig(env, undefined, overrides);
  try {
    const rows = await env.DB.prepare(
      `SELECT id, slot_key, type, run_at, mode, domain, target_chat_id, title,
              substr(body, 1, 220) AS preview, length(body) AS body_len,
              status, provider, model, edited_at, published_at, message_id, error
       FROM digest_posts ORDER BY run_at DESC LIMIT 50`,
    ).all<DigestListRow>();
    return json({
      auto_publish: cfg.autoPublish,
      enabled: resolveDigestEnabled(env, overrides),
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
  // Resolved display name for the target chat (static config, not a live
  // lookup — a Bot API call per dialog-open is unjustified for a label).
  const overrides = await loadSettingOverrides(env.DB);
  const cfg = resolveDigestConfig(env, undefined, overrides);
  return json({ ...row, target_name: cfg.targetChatName ?? null });
}

/**
 * Draft actions: save (persist edits), publish (sanitize + send), discard,
 * retry (re-send a failed row's body — no LLM, same send contract).
 * Drafts are mutable; failed rows accept only retry; anything else is final.
 */
async function handleDigestAction(
  env: Env,
  id: number,
  action: 'save' | 'publish' | 'discard' | 'retry',
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
  // Status gate per action: save/publish/discard need a draft; retry needs a
  // failed row (plan §11.4's regenerate promise for failed sends). Anything
  // else is final.
  const needDraft = action === 'save' || action === 'publish' || action === 'discard';
  if (needDraft && row.status !== 'draft') {
    return json({ error: `Row is ${row.status}; only drafts are mutable` }, 409);
  }
  if (action === 'retry' && row.status !== 'failed') {
    return json({ error: `Row is ${row.status}; only failed rows can retry` }, 409);
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

  // publish + retry share one send contract (retry re-sends a failed row's
  // stored body — no LLM involved). The status gate above is what keeps them
  // apart: publish needs a draft, retry needs a failed row.
  // Contract mirrors the pipeline (sanitize → RTL marks → sponsor append) so
  // manual sends render like auto-publishes (review 1, P1-5). Cap is the
  // deep-slot limit (≥ every pipeline slot cap; edited drafts run longer;
  // chunked send copes);
  // sponsor resolves override-aware, not env-only.
  const overrides = await loadSettingOverrides(env.DB);
  const cfg = resolveDigestConfig(env, undefined, overrides);
  const sponsorRaw = (cfg.sponsorText ?? '').trim();
  let sponsorSuffix = '';
  if (sponsorRaw) {
    sponsorSuffix =
      '\n\n<i>' +
      sponsorRaw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;') +
      '</i>';
  }
  const clean =
    applyRtlMarks(sanitizeTelegramHtml(row.body, DIGEST_DEEP_BODY_LIMIT)) + sponsorSuffix;
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
      reason: action === 'retry' ? 'admin_retry' : 'admin_publish',
      extra: { postId: id, slot: row.slot_key, messageId: sent.messageId },
    });
    return json({ ok: true, action, message_id: sent.messageId });
  }
  await env.DB.prepare(`UPDATE digest_posts SET status='failed', error=? WHERE id=?`)
    .bind(sent.description ?? 'send_failed', id)
    .run();
  await logger.error('news_error', {
    chat_id: Number(row.target_chat_id) || null,
    reason: `admin_${action}_failed: ${sent.description ?? ''}`,
    extra: { postId: id, slot: row.slot_key },
  });
  return json({ ok: false, error: sent.description ?? 'send_failed' }, 502);
}

/**
 * Dev-only: run the REAL pipeline (engines → extraction → LLM → draft row) as
 * if the cron had fired at the chosen local hour + slot tag, so a test draft
 * mirrors exactly what production would post — including per-slot engines,
 * mode, token budget, the deep slot's D1-sourced behavior, and extraction.
 * Cost-justified: gated behind the (gitignored) NEWS_DEV_SEED toggle, which
 * is never set in production. Each call runs a fresh pipeline pass; the
 * result appears in Pending drafts for review/edit/publish/discard.
 */
async function handleDigestSeed(
  env: Env,
  hour: number,
  tag: string,
): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const overrides = await loadSettingOverrides(env.DB);
  // Dev-seed gate honors the runtime override → env → default.
  const seedOn = isSeedEnabled(
    overrides['digest_dev_seed'] ?? env.NEWS_DEV_SEED,
  );
  if (!seedOn) {
    return json({ error: 'Seed disabled (set NEWS_DEV_SEED=true or the digest_dev_seed setting)' }, 404);
  }
  const cfg = resolveDigestConfig(env, undefined, overrides);
  if (!cfg.targetChatId) {
    return json({ error: 'NEWS_TARGET_CHAT_ID required to seed a draft' }, 400);
  }
  // The tag is what the cron would run at that hour; unknown/empty falls
  // back to the resolved schedule entry (or a plain daily if none).
  const schedule = parseSchedule(effectiveSchedule(env, overrides));
  const validTag =
    tag === 'headlines' || tag === 'trending' || tag === 'papers' || tag === 'deep'
      ? tag
      : undefined;
  const effectiveTag: SlotTag = validTag ?? (schedule[hour]?.tag as SlotTag | undefined) ?? 'headlines';

  // Honest no-op signal: the seed writes the real cron slot key, so seeding
  // an already-run slot would silently do nothing — say so instead of a
  // misleading ok:true.
  const lpSeed = { ...localParts(env.TIMEZONE), hour };
  const seedType = resolveDigestType(env, cfg, lpSeed, overrides)?.type ?? 'daily';
  const seedKey = computeSlotKey(seedType, lpSeed, effectiveTag);
  const existing = await env.DB.prepare(
    `SELECT status FROM digest_posts WHERE slot_key = ? AND target_chat_id = ?`,
  )
    .bind(seedKey, cfg.targetChatId)
    .first<{ status: string }>();
  if (existing) {
    return json(
      {
        ok: false,
        error: `slot ${seedKey} already ${existing.status} — seed would no-op`,
        slot_key: seedKey,
        tag: effectiveTag,
        hour,
      },
      409,
    );
  }

  try {
    const { slotKey } = await runDigestFromHour(env, hour, effectiveTag);
    return json({ ok: true, slot_key: slotKey, tag: effectiveTag, hour });
  } catch (err) {
    return json(
      { error: `seed pipeline failed: ${String(err).slice(0, 300)}` },
      500,
    );
  }
}

/**
 * Published-posts view with the Digest filter bar (plan §23.2): domain /
 * type / slot tag / date range / status / min reactions / trend — all
 * server-side. Trend and min_reactions depend on presentation-time analytics,
 * so the scan window (200 latest) is fetched, decorated, filtered, then
 * paginated.
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
    // Intraday slot tag lives in the slot-key suffix (`<date>T<hh>:<tag>`);
    // untagged legacy keys simply don't match a tag filter.
    const tag = (q.get('tag') || '').trim();
    if (tag === 'headlines' || tag === 'trending' || tag === 'papers' || tag === 'deep') {
      conds.push(`dp.slot_key LIKE '%' || ':' || ?`);
      binds.push(tag);
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
              dp.message_id, dp.target_chat_id, dp.edited_at, dp.body, dp.slot_key
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
        slot_key: string | null;
      }>();
    const rows = scan.results ?? [];

    const overrides = await loadSettingOverrides(env.DB);
    const cfg = resolveDigestConfig(env, undefined, overrides);
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
      tag: slotTagOf(r.slot_key),
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

/**
 * Intraday slot tag from a slot key (`<date>T<hh>:<tag>`). Untagged legacy
 * keys and rollup keys (weekly-*, monthly-*) yield null — the tag column
 * shows a dash for those instead of guessing.
 */
export function slotTagOf(
  slotKey: string | null,
): 'headlines' | 'trending' | 'papers' | 'deep' | null {
  const m = /:([A-Za-z]+)$/.exec(slotKey ?? '');
  const tag = m?.[1];
  return tag === 'headlines' || tag === 'trending' || tag === 'papers' || tag === 'deep'
    ? tag
    : null;
}

async function handleDigestSettings(env: Env): Promise<Response> {
  const overrides = env.DB ? await loadSettingOverrides(env.DB) : {};
  const cfg = resolveDigestConfig(env, undefined, overrides);
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
    rollupHour: rollupHourFromSchedule(parseSchedule(effectiveSchedule(env, overrides))),
    localHour: localParts(env.TIMEZONE).hour,
    // Display timezone for the panel (worker stores UTC; times render here).
    timezone: env.TIMEZONE || 'UTC',
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
    // when NEWS_SCHEDULE is unset — rollupHour is null in that case too (the
    // digest does not run at all without a schedule).
    schedule: parseSchedule(effectiveSchedule(env, overrides)),
    // Lets the panel hide the "Insert test draft" button unless the dev seed
    // toggle is on — the endpoint is 04'd server-side otherwise, so there's no
    // point offering a button that can only fail.
    dev_seed: isSeedEnabled(overrides['digest_dev_seed'] ?? env.NEWS_DEV_SEED),
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
  const intent = parseDraftsPath(url.pathname.slice(base.length));

  if (intent.kind === 'list' && request.method === 'GET') {
    return handleDigestList(env);
  }
  if (intent.kind === 'action') {
    if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
    return handleDigestAction(env, intent.id, intent.action, request);
  }
  if (intent.kind === 'one') {
    return handleDigestOne(env, intent.id);
  }
  return json({ error: 'Not found' }, 404);
}

export const digestAdminRoutes: AdminRoute[] = [
  // Registered for BOTH methods: GET lists/loads a draft, POST acts on it
  // (save/publish/discard). The dispatch loop filters on method, so a single
  // entry would make the other method fall through to 404.
  { method: 'GET', prefix: '/api/digest/drafts', handler: handleDraftsRoute },
  { method: 'POST', prefix: '/api/digest/drafts', handler: handleDraftsRoute },
  // Dev-only seed (NEWS_DEV_SEED=true): run the REAL pipeline from a chosen
  // local hour + slot tag so a test draft mirrors what the cron would post —
  // exercises engines, extraction, LLM, and the draft workflow end-to-end.
  {
    method: 'POST',
    rest: '/api/digest/dev/seed',
    handler: async (request, env) => {
      if (!csrfOk(request)) return json({ error: 'CSRF check failed' }, 403);
      let hour: number = -1;
      let tag = '';
      try {
        const body = (await request.json().catch(() => ({}))) as {
          hour?: unknown;
          tag?: unknown;
        };
        if (typeof body.hour === 'number' && Number.isInteger(body.hour)) {
          hour = body.hour;
        }
        if (typeof body.tag === 'string') tag = body.tag;
      } catch {
        // body parse failure — fall through with defaults
      }
      // Default: the current local hour (what a cron tick RIGHT NOW would run).
      if (hour < 0 || hour > 23) hour = localParts(env.TIMEZONE).hour;
      return handleDigestSeed(env, hour, tag);
    },
  },
  { method: 'GET', rest: '/api/digest/stats', handler: (request, env) => handleDigestStats(request, env) },
  { method: 'GET', rest: '/api/digest/settings', handler: (_q, env) => handleDigestSettings(env) },
];
