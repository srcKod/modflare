/**
 * Moderation's admin API: filtered/paginated audit-log queries, summary,
 * event list, self-clean queue, and CSV export. Strictly read-only (SELECT
 * only) — an audit panel never mutates logs. Wired into the panel shell via
 * the feature manifest (core/router.ts AdminRoute).
 */

import { envBool } from '../../core/config';
import { json } from '../../core/admin';
import type { AdminRoute } from '../../core/router';
import type { Env } from '../../core/types';
import { parseModerationDetailed } from './llm';

/** Hard cap on rows returned by the CSV export to avoid OOM. */
const EXPORT_MAX_ROWS = 5000;

/* ------------------------------------------------------------------ */
/* Query builder (parameterized — no string-concatenated user input)    */
/* ------------------------------------------------------------------ */

interface LogFilters {
  level?: string;
  event?: string;
  decision?: string;
  chat_id?: string;
  user_id?: string;
  from?: string;
  to?: string;
  q?: string;
}

function buildWhere(
  f: LogFilters,
): { whereSql: string; binds: (string | number)[] } {
  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (f.level) {
    conds.push('level = ?');
    binds.push(f.level);
  }
  if (f.event) {
    conds.push('event = ?');
    binds.push(f.event);
  }
  if (f.decision) {
    conds.push('decision = ?');
    binds.push(f.decision);
  }
  const chat = Number(f.chat_id);
  if (f.chat_id && !Number.isNaN(chat)) {
    conds.push('chat_id = ?');
    binds.push(chat);
  }
  const user = Number(f.user_id);
  if (f.user_id && !Number.isNaN(user)) {
    conds.push('user_id = ?');
    binds.push(user);
  }
  if (f.from && !Number.isNaN(Date.parse(f.from))) {
    conds.push('ts >= ?');
    binds.push(new Date(f.from).toISOString());
  }
  if (f.to && !Number.isNaN(Date.parse(f.to))) {
    conds.push('ts <= ?');
    binds.push(new Date(f.to).toISOString());
  }
  if (f.q && f.q.trim()) {
    // FTS5 full-text search — ~10x faster than LIKE '%...%' on large datasets.
    // MATCH uses the FTS5 query syntax: plain words, "phrases", prefix*
    conds.push('id IN (SELECT rowid FROM audit_log_fts WHERE audit_log_fts MATCH ?)');
    binds.push(f.q.trim());
  }
  return {
    whereSql: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    binds,
  };
}

function parseFilters(url: URL): LogFilters {
  return {
    level: url.searchParams.get('level') || undefined,
    event: url.searchParams.get('event') || undefined,
    decision: url.searchParams.get('decision') || undefined,
    chat_id: url.searchParams.get('chat_id') || undefined,
    user_id: url.searchParams.get('user_id') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    q: url.searchParams.get('q') || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                             */
/* ------------------------------------------------------------------ */

async function handleLogs(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const url = new URL(request.url);
  const f = parseFilters(url);
  const { whereSql, binds } = buildWhere(f);

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const perPage = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get('per_page')) || 50),
  );
  const offset = (page - 1) * perPage;

  const countRes = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM audit_log ${whereSql}`,
  )
    .bind(...binds)
    .first<{ c: number }>();

  const rows = await env.DB.prepare(
    `SELECT id, ts, level, event, provider, model,
            chat_id, chat_username, chat_title,
            user_id, username, full_name, decision, reason,
            message_text, llm_response
     FROM audit_log ${whereSql}
     ORDER BY ts DESC, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...binds, perPage, offset)
    .all();

  const count = countRes?.c ?? 0;
  return json({
    rows: rows.results ?? [],
    count,
    page,
    per_page: perPage,
    has_more: offset + (rows.results?.length ?? 0) < count,
  });
}

async function handleSummary(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const url = new URL(request.url);
  const f = parseFilters(url);
  const { whereSql, binds } = buildWhere(f);

  const byLevel = await env.DB.prepare(
    `SELECT level, COUNT(*) AS c FROM audit_log ${whereSql} GROUP BY level`,
  )
    .bind(...binds)
    .all();
  const byEvent = await env.DB.prepare(
    `SELECT event, COUNT(*) AS c FROM audit_log ${whereSql} GROUP BY event ORDER BY c DESC`,
  )
    .bind(...binds)
    .all();

  return json({
    by_level: byLevel.results ?? [],
    by_event: byEvent.results ?? [],
  });
}

async function handleEvents(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const res = await env.DB.prepare(
    'SELECT DISTINCT event FROM audit_log ORDER BY event',
  ).all();
  return json((res.results ?? []).map((r) => (r as { event: string }).event));
}

/**
 * GET /api/bot-queue?kind=fun
 * Pending bot_messages rows (the self-clean queue) with per-row eligibility
 * flags. Read-only, like everything else here.
 */
async function handleBotQueue(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const url = new URL(request.url);
  const kind = (url.searchParams.get('kind') || '').trim();
  const enabled = envBool(env.ENABLE_SELF_CLEAN, false);
  const ttlMinutes = Number(env.SELF_CLEAN_TTL_MINUTES) || 60;
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  try {
    const stmt = env.DB.prepare(
      `SELECT id, message_id, chat_id, chat_username, message, kind, sent_at, attempts
       FROM bot_messages ${kind ? 'WHERE kind = ? ' : ''}ORDER BY sent_at LIMIT 200`,
    );
    const res = await (kind ? stmt.bind(kind) : stmt).all();
    const rows = (res.results ?? []).map((r) => {
      const row = r as {
        id: number;
        message_id: number;
        chat_id: number;
        chat_username: string | null;
        message: string | null;
        kind: string;
        sent_at: string;
        attempts: number;
      };
      return { ...row, eligible: row.sent_at <= cutoff };
    });
    return json({ enabled, ttl_minutes: ttlMinutes, rows });
  } catch (err) {
    return json({ error: `bot queue query failed: ${err}` }, 500);
  }
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const url = new URL(request.url);
  const f = parseFilters(url);
  const { whereSql, binds } = buildWhere(f);

  const rows = await env.DB.prepare(
    `SELECT ts, level, event, provider, model,
            chat_id, chat_username, chat_title,
            user_id, username, full_name, decision, reason,
            message_text, llm_response
     FROM audit_log ${whereSql}
     ORDER BY ts DESC, id DESC
     LIMIT ${EXPORT_MAX_ROWS}`,
  )
    .bind(...binds)
    .all();

  return new Response(
    buildExportCsv((rows.results ?? []) as Record<string, unknown>[]),
    {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${Date.now()}.csv"`,
      },
    },
  );
}

/**
 * Normalized export header. The model's raw reply is parsed into atomic
 * columns (`flag`, `llm_reason`, `fun_response`) so the file is directly
 * filterable for dataset work — e.g. keep rows where `parse_status` is
 * `json` and `event` is flagged/safe — while `llm_response_raw` keeps the
 * lossless original as the last column.
 *
 * `parse_status` vocabulary:
 *  - `json`          — reply was strict JSON; flag/llm_reason filled
 *  - `json_in_prose` — JSON object extracted from surrounding prose
 *  - `plain`         — plain flag line ("true"/"yes"); flag=true, no reason
 *  - `empty`         — empty reply cell (transport error / model said nothing)
 *  - `` (blank)      — the event never carried a model reply (skips, errors)
 */
export const EXPORT_CSV_HEADER = [
  'ts', 'level', 'event', 'provider', 'model',
  'chat_id', 'chat_username', 'chat_title',
  'user_id', 'username', 'full_name',
  'decision', 'reason',
  'flag', 'llm_reason', 'fun_response', 'parse_status',
  'message_text', 'llm_response_raw',
] as const;

/** Build the normalized export CSV: BOM + header row + one line per row. */
export function buildExportCsv(rows: Record<string, unknown>[]): string {
  const lines = [EXPORT_CSV_HEADER.join(',')];
  for (const row of rows) {
    const hasReply = typeof row.llm_response === 'string';
    const raw = hasReply ? (row.llm_response as string) : '';
    const parsed = parseModerationDetailed(raw);
    const shaped: Record<string, unknown> = {
      ...row,
      flag: parsed.flag === undefined ? '' : String(parsed.flag),
      llm_reason: parsed.reason ?? '',
      fun_response: parsed.funResponse ?? '',
      parse_status: hasReply ? parsed.status : '',
      llm_response_raw: raw,
    };
    lines.push(EXPORT_CSV_HEADER.map((h) => csvCell(shaped[h])).join(','));
  }
  // UTF-8 BOM so spreadsheet apps auto-detect the encoding for non-ASCII
  // content (message text and fun replies are frequently non-Latin).
  return `\uFEFF${lines.join('\n')}`;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Moderation's contribution to the admin panel API (all GET, read-only). */
export const moderationAdminRoutes: AdminRoute[] = [
  { method: 'GET', rest: '/api/logs', handler: handleLogs },
  { method: 'GET', rest: '/api/summary', handler: handleSummary },
  { method: 'GET', rest: '/api/events', handler: handleEvents },
  { method: 'GET', rest: '/api/bot-queue', handler: handleBotQueue },
  { method: 'GET', rest: '/export.csv', handler: handleExport },
];
