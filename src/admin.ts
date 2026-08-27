import type { Env } from './types';
import LOGIN_HTML from './templates/login.html';
import PANEL_HTML from './templates/admin.html';
import STYLE_CSS from './templates/css/style.css';
import APP_JS from './templates/js/app.js';

/**
 * Admin panel: a read-only, filtered, paginated view of the D1 audit log,
 * hosted on the SAME worker as the bot (no separate service).
 *
 * Security model:
 *  - Disabled entirely unless ADMIN_PANEL_TOKEN is set.
 *  - Served under a configurable path (ADMIN_PANEL_PATH, default /admin) so a
 *    random path hides it from casual discovery.
 *  - Login via a username-less token form; on success a short-lived, HMAC-signed,
 *    HttpOnly + Secure + SameSite cookie is set. No session table needed.
 *  - The API is strictly read-only (SELECT only) — an audit panel should never
 *    let you mutate logs.
 *
 * Routes (all under ADMIN_PANEL_PATH):
 *   GET  <path>            -> login page (if no cookie) or the panel HTML
 *   POST <path>/login      -> validate token, set cookie, 303 to <path>
 *   POST <path>/logout     -> clear cookie
 *   GET  <path>/api/logs   -> JSON: filtered rows + count + page info
 *   GET  <path>/api/summary-> JSON: counts by level/decision matching filters
 *   GET  <path>/api/events -> JSON: distinct event values for the dropdown
 *   GET  <path>/export.csv -> same filters, downloaded as CSV
 *   GET  <path>/style.css  -> panel stylesheet (cookie-gated)
 *   GET  <path>/app.js     -> panel client script (cookie-gated)
 */

const DEFAULT_PATH = '/admin';
const DEFAULT_TTL_SECONDS = 43200; // 12h
const COOKIE_NAME = 'adm';
/** Hard cap on rows returned by the CSV export to avoid OOM. */
const EXPORT_MAX_ROWS = 5000;

const enc = new TextEncoder();

/** Is the admin panel even enabled? Only when a token is configured. */
export function adminEnabled(env: Env): boolean {
  return Boolean(env.ADMIN_PANEL_TOKEN && env.ADMIN_PANEL_TOKEN.trim());
}

/** Resolve the configured admin panel path (default /admin). */
export function adminPath(env: Env): string {
  const p = (env.ADMIN_PANEL_PATH || DEFAULT_PATH).trim();
  return p.startsWith('/') ? p : `/${p}`;
}

/** Top-level router: returns a Response, or null if this path isn't ours. */
export async function handleAdmin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!adminEnabled(env)) return null;

  const base = adminPath(env);
  const url = new URL(request.url);
  if (!url.pathname.startsWith(base)) return null;

  const rest = url.pathname.slice(base.length) || '/';

  // Public-ish endpoints (login/logout) have their own auth handling.
  if (
    (request.method === 'POST' && (rest === '/login' || rest === '/logout')) ||
    (request.method === 'GET' && rest === '/logout')
  ) {
    return handleAuth(request, env, rest);
  }

  // Everything else requires a valid cookie.
  if (!(await verifyCookie(request, env))) {
    if (request.method === 'GET' && (rest === '/' || rest === '')) {
      return loginPage(env);
    }
    return json({ error: 'Unauthorized' }, 401);
  }

  if (rest === '/' || rest === '' || rest === '/panel') {
    return panelPage(env);
  }
  if (rest === '/style.css') return staticAsset(STYLE_CSS, 'text/css; charset=utf-8');
  if (rest === '/app.js') return staticAsset(APP_JS, 'text/javascript; charset=utf-8');
  if (rest === '/api/logs') return handleLogs(request, env);
  if (rest === '/api/summary') return handleSummary(request, env);
  if (rest === '/api/events') return handleEvents(env);
  if (rest === '/export.csv') return handleExport(request, env);

  return json({ error: 'Not found' }, 404);
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function handleAuth(
  request: Request,
  env: Env,
  rest: string,
): Promise<Response> {
  if (rest === '/logout') {
    return new Response(null, {
      status: 303,
      headers: {
        Location: adminPath(env),
        'Set-Cookie': `${COOKIE_NAME}=; Path=${adminPath(env)}; Max-Age=0; HttpOnly; SameSite=Strict; Secure`,
      },
    });
  }

  // /login
  let body: { token?: string } = {};
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const token = body.token ?? '';
  if (!constantTimeEqual(token, env.ADMIN_PANEL_TOKEN || '')) {
    return json({ error: 'Invalid token' }, 401);
  }

  const ttl = Number(env.ADMIN_PANEL_TTL) || DEFAULT_TTL_SECONDS;
  const cookie = await makeCookie(env, ttl);
  return new Response(null, {
    status: 303,
    headers: {
      Location: adminPath(env),
      'Set-Cookie': `${COOKIE_NAME}=${cookie}; Path=${adminPath(env)}; Max-Age=${ttl}; HttpOnly; SameSite=Strict; Secure`,
    },
  });
}

/** Create an HMAC-signed cookie value: b64url(payload).hexsig(payload). */
async function makeCookie(env: Env, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = base64urlEncode(JSON.stringify({ exp }));
  const sig = await hmacHex(env.ADMIN_PANEL_TOKEN || '', payload);
  return `${payload}.${sig}`;
}

/** Verify the cookie's signature and expiry. */
async function verifyCookie(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Cookie') || '';
  const match = header
    .split(';')
    .map((s) => s.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;

  const value = match.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = await hmacHex(env.ADMIN_PANEL_TOKEN || '', payload);
  if (!constantTimeEqual(sig, expected)) return false;

  try {
    const parsed = JSON.parse(base64urlDecode(payload)) as { exp?: number };
    if (typeof parsed.exp !== 'number' || parsed.exp * 1000 < Date.now()) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time comparison to avoid timing side channels on the token. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

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
/* API handlers                                                         */
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

async function handleEvents(env: Env): Promise<Response> {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const res = await env.DB.prepare(
    'SELECT DISTINCT event FROM audit_log ORDER BY event',
  ).all();
  return json((res.results ?? []).map((r) => (r as { event: string }).event));
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

  const header = ['ts', 'level', 'event', 'provider', 'model', 'chat_id', 'chat_username', 'chat_title', 'user_id', 'username', 'full_name', 'decision', 'reason', 'message_text', 'llm_response'];
  const lines = [header.join(',')];
  for (const r of rows.results ?? []) {
    const row = r as Record<string, unknown>;
    lines.push(
      header
        .map((h) => csvCell(row[h]))
        .join(','),
    );
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${Date.now()}.csv"`,
    },
  });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/* Small response helpers                                               */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Serve a bundled static asset (Text import) with its MIME type. */
function staticAsset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      // Small, auth-gated, and must reflect deploys immediately.
      'Cache-Control': 'no-cache',
    },
  });
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function loginPage(env: Env): Response {
  const base = adminPath(env);
  const html = LOGIN_HTML.replaceAll('__BASE_PATH__', base);
  return htmlResponse(html);
}


function panelPage(env: Env): Response {
  const base = adminPath(env);
  const html = PANEL_HTML.replaceAll('__BASE_JSON__', JSON.stringify(base)).replaceAll('__BASE_PATH__', base);
  return htmlResponse(html);
}
