import type { Env } from './types';

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

  // Public-ish endpoints (login) have their own auth handling.
  if (request.method === 'POST' && (rest === '/login' || rest === '/logout')) {
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
        'Set-Cookie': `${COOKIE_NAME}=; Path=${adminPath(env)}; Max-Age=0; HttpOnly; SameSite=Strict`,
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

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function loginPage(env: Env): Response {
  const base = adminPath(env);
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin login</title>
<style>body{font-family:system-ui,sans-serif;max-width:360px;margin:80px auto;padding:0 20px;color:#1a202c}
h1{font-size:1.4rem}input{width:100%;padding:10px;box-sizing:border-box;margin:8px 0;font-size:1rem}
button{width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:1rem;cursor:pointer}
.error{color:#dc2626;min-height:1.2em}</style></head><body>
<h1>Admin login</h1>
<input type="password" id="token" placeholder="Access token" autofocus>
<button onclick="login()">Sign in</button>
<p class="error" id="err"></p>
<script>
async function login(){
  const token=document.getElementById('token').value;
  const err=document.getElementById('err');
  err.textContent='';
  const r=await fetch('${base}/login',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token})});
  if(r.ok){location.href='${base}/';}
  else if(r.status===401){err.textContent='Invalid token';}
  else{err.textContent='Login failed ('+r.status+')';}
}
</script></body></html>`;
  return htmlResponse(html);
}


function panelPage(env: Env): Response {
  const base = adminPath(env);
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit Log</title>
<style>
:root{--line:#e5e7eb;--bg:#fff;--muted:#6b7280}
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;background:#f9fafb;color:#111827}
header{background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header h1{font-size:1.1rem;margin:0}
header .spacer{flex:1}
main{padding:20px;max-width:1400px;margin:0 auto}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:120px}
.stat .num{font-size:1.6rem;font-weight:600}
.stat .lbl{font-size:.8rem;color:var(--muted)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.filters input,.filters select{padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:.9rem;background:#fff}
.filters button{padding:6px 14px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:.9rem}
table{width:100%;border-collapse:collapse;background:var(--bg)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:.85rem;vertical-align:top}
th{position:sticky;top:0;background:#f3f4f6;cursor:pointer;user-select:none}
td .reason{color:var(--muted);max-width:340px;white-space:pre-wrap;word-break:break-word}
td .mono{font-family:ui-monospace,monospace;font-size:.75rem}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:600}
.badge.delete{background:#fee2e2;color:#b91c1c}
.badge.keep{background:#dcfce7;color:#15803d}
.badge.warn{background:#fef3c7;color:#b45309}
.badge.error{background:#fee2e2;color:#b91c1c}
.badge.info{background:#e0e7ff;color:#4338ca}
.badge.debug{background:#f3f4f6;color:#4b5563}
.pagination{display:flex;gap:8px;align-items:center;margin-top:16px}
.pagination button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}
.pagination button:disabled{opacity:.4;cursor:default}
.pagination .info{color:var(--muted);font-size:.85rem}
a.logout{color:#2563eb;text-decoration:none;font-size:.9rem}
.empty{color:var(--muted);text-align:center;padding:40px 0}
.error{color:#dc2626;text-align:center;padding:20px}

/* Responsive table wrapper: horizontal scroll on narrow screens so columns
   don't squish unreadably. */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{min-width:760px}
.col-time{width:148px}
.col-level{width:64px}
.col-event{width:120px}
.col-decision{width:78px}
.col-details{width:54px}

/* Friendly identifiers: primary value is the @handle (link-styled); the
   fallback id sits underneath in a smaller mono style. */
.id-cell{display:flex;flex-direction:column;line-height:1.25;min-width:120px}
.id-cell .primary{font-weight:600;color:#111827}
.id-cell .primary.handle{color:#2563eb}
.id-cell .secondary{font-size:.7rem;color:var(--muted);font-family:ui-monospace,monospace}
/* Reason & Message cells: clamp to 2 lines in the main table so a long
   message never blows up the row height. The full text is always available
   in the expanded Details panel below. */
.col-msg .reason,.col-reason .reason{
  color:var(--muted);max-width:340px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden;white-space:pre-wrap;word-break:break-word
}

/* Details toggle: small ghost button that opens an inline expansion row. */
.details-btn{
  display:inline-block;padding:4px 10px;border:1px solid var(--line);
  border-radius:6px;background:#fff;cursor:pointer;font-size:.78rem;
  color:#2563eb;user-select:none;white-space:nowrap;font-weight:500
}
.details-btn:hover{background:#eff6ff}
.details-btn[aria-expanded="true"]{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8}

/* Expanded details row: spans all columns, renders the full audit row as a
   structured property panel. The inner is a 2-column CSS grid at wide
   widths: When+Identity pair side-by-side, Event+Action pair side-by-side,
   Message and LLM verdict span both columns. At narrow widths it falls
   back to a single column. */
.details-row td{background:#f9fafb;padding:0;border-bottom:1px solid var(--line)}
.details-inner{
  padding:12px 16px;
  font-size:.82rem;
  line-height:1.5;
  color:#374151
}
/* At-a-glance metadata bar: ts | id | level | event | decision */
.d-meta{
  display:flex;align-items:center;gap:6px;
  flex-wrap:wrap;margin-bottom:6px;
  font-size:.78rem
}
.d-meta .sep{color:var(--muted);opacity:.5}
.d-ts{font-family:ui-monospace,monospace;font-size:.76rem;color:#111827}
.d-id{font-family:ui-monospace,monospace;font-size:.72rem;color:var(--muted)}
/* Identity: chat + user on separate lines */
.d-who{
  display:flex;flex-wrap:wrap;gap:4px 16px;
  margin-bottom:4px;font-size:.78rem
}
.d-who-item{display:flex;align-items:baseline;gap:4px}
.d-who-item .who-key{color:var(--muted);font-size:.72rem;min-width:30px}
.d-who-item .who-val{font-weight:600;color:#111827}
.d-who-item .who-id{font-family:ui-monospace,monospace;font-size:.68rem;color:var(--muted)}
/* Message bubble — subtle box around the posted text */
.d-bubble{
  background:#fff;border:1px solid var(--line);
  border-radius:8px;padding:8px 12px;
  font-size:.82rem;line-height:1.4;
  color:#111827;margin:6px 0;
  max-height:140px;overflow-y:auto;
  white-space:pre-wrap;word-break:break-word
}
/* Reason line — subdued */
.d-why{
  font-size:.76rem;color:#6b7280;
  margin-bottom:4px;line-height:1.35
}
/* LLM attribution: provider · model · flag on one line */
.d-ai{
  display:flex;align-items:center;gap:6px;
  flex-wrap:wrap;margin-bottom:4px;
  font-size:.72rem;color:var(--muted)
}
.d-ai .ai-prov{font-weight:500;color:#475569}
.d-ai .ai-sep{opacity:.4}
/* fun_response: green left-border callout — the visual focal point */
.d-fun{
  background:#ecfdf5;border-left:3px solid #10b981;
  padding:8px 12px;border-radius:0 6px 6px 0;
  color:#064e3b;font-style:italic;
  font-size:.84rem;line-height:1.45;
  margin-bottom:4px
}
/* Per-row provider/model chip shown under the Reason cell so users can
   see at a glance which LLM produced each row. */
.llm-meta{
  margin-top:3px;font-size:.68rem;color:var(--muted);
  display:flex;align-items:center;gap:4px;line-height:1.2;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis
}
.llm-meta .prov{color:#475569;font-weight:500}
.llm-meta .sep{opacity:.5}
.llm-meta .model{color:#6b7280}
.callout{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.76rem;font-weight:600}
.flag-on{background:#fee2e2;color:#b91c1c}
.flag-off{background:#dcfce7;color:#15803d}
/* Raw JSON toggle — minimal text link */
.d-raw{margin-top:2px}
.d-raw>summary{
  list-style:none;display:inline-flex;align-items:center;gap:4px;
  font-size:.7rem;color:#6b7280;cursor:pointer;user-select:none
}
.d-raw>summary::-webkit-details-marker{display:none}
.d-raw>summary::before{
  content:"{ }";font-family:ui-monospace,monospace;font-size:.72rem;
  color:#9ca3af;letter-spacing:-1px
}
.d-raw>summary:hover{color:#374151}
.d-raw[open]>summary{color:#1d4ed8}
.d-raw[open]>summary::before{color:#2563eb}
.d-raw pre{
  margin:8px 0 0;background:#0f172a;color:#e2e8f0;
  padding:10px 12px;border-radius:6px;font-size:.72rem;
  overflow:auto;max-height:220px;line-height:1.45
}

/* Narrow screens: stack filters, shrink paddings, hide less-critical columns. */
@media (max-width:720px){
  main{padding:12px}
  .filters input,.filters select{font-size:.8rem}
  .col-time,.col-level{width:auto}
  th,td{padding:6px 8px;font-size:.78rem}
  .col-decision{display:none}
  .id-cell{min-width:0}
  /* Details panel: tighter on phones */
  .details-inner{padding:8px 10px;font-size:.76rem}
  .d-bubble{max-height:100px;font-size:.78rem}
  .d-fun{font-size:.78rem;padding:6px 10px}
  /* Tighter table on phones: shorter time column, smaller fonts. */
  .col-time{width:110px}
  .col-event{width:auto}
  .id-cell .primary{font-size:.78rem}
  .id-cell .secondary{font-size:.65rem}
}
</style></head><body>
<header>
  <h1>Audit Log</h1>
  <div class="spacer"></div>
  <a class="logout" href="${base}/logout">Log out</a>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div class="filters" id="filters">
    <select id="f-level"><option value="">level</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select>
    <select id="f-event"><option value="">event</option></select>
    <select id="f-decision"><option value="">decision</option><option>delete</option><option>keep</option></select>
    <input id="f-chat" placeholder="chat id" style="width:110px">
    <input id="f-user" placeholder="user id" style="width:110px">
    <input id="f-from" type="date" style="width:125px" title="From date (UTC)">
    <input id="f-to" type="date" style="width:125px" title="To date (UTC)">
    <input id="f-q" placeholder="search text/reason" style="width:200px">
    <button id="apply">Apply</button>
    <button id="export" title="Download filtered rows as CSV">Export CSV</button>
  </div>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th data-k="ts" class="col-time">Time</th>
      <th data-k="level" class="col-level">Level</th>
      <th data-k="event" class="col-event">Event</th>
      <th data-k="chat_username" class="col-chat">Chat</th>
      <th data-k="user_id" class="col-user">User</th>
      <th data-k="decision" class="col-decision">Decision</th>
      <th data-k="reason" class="col-reason">Reason</th>
      <th data-k="message_text" class="col-msg">Message</th>
      <th class="col-details" aria-label="Row details"></th>
    </tr></thead>
    <tbody id="rows"><tr class="empty"><td colspan="9">Loading…</td></tr></tbody>
  </table>
  </div>
  <div class="pagination">
    <button id="prev">‹ Prev</button>
    <span class="info" id="page-info"></span>
    <button id="next">Next ›</button>
  </div>
</main>
<script>
const base=${JSON.stringify(base)};
let page=1, perPage=50;
function qs(){const p=new URLSearchParams();
  const v=(id)=>document.getElementById(id).value.trim();
  if(v('f-level'))p.set('level',v('f-level'));
  if(v('f-event'))p.set('event',v('f-event'));
  if(v('f-decision'))p.set('decision',v('f-decision'));
  if(v('f-chat'))p.set('chat_id',v('f-chat'));
  if(v('f-user'))p.set('user_id',v('f-user'));
  if(v('f-from'))p.set('from',v('f-from'));
  if(v('f-to'))p.set('to',v('f-to'));
  if(v('f-q'))p.set('q',v('f-q'));
  return p;}
function esc(s){return (s==null?'':String(s))
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');}
function badge(kind,label){return '<span class="badge '+kind+'">'+esc(label)+'</span>';}
function levelBadge(l){return badge(l, l||'—');}
function decisionBadge(d){return d==='delete'?badge('delete','delete')
  :d==='keep'?badge('keep','keep'):'<span class="mono">—</span>';}
/**
 * Shorten a provider URL to a recognizable host label.
 *   https://gateway.ai.cloudflare.com/...  -> cloudflare
 *   https://api.cline.bot/api/v1            -> cline
 *   https://api.openai.com/v1               -> openai
 *   https://openrouter.ai/api/v1            -> openrouter
 *   https://api.rntm.sh/v1                  -> rntm
 * Strategy: strip common subdomains (api., gateway., compat.), then
 * prefer the second-to-last label so ai.X.com style hosts surface the
 * brand, not the literal 'ai'. Two-label hosts (openrouter.ai) just use
 * the first label. Falls back to the raw string if URL parsing fails.
 */
function shortProvider(url){
  if(!url) return '—';
  try{
    const u=new URL(url);
    let host=u.hostname;
    host=host.replace(/^api\./,'').replace(/^gateway\./,'').replace(/^compat\./,'');
    const labels=host.split('.');
    if(labels.length>=2) return labels[labels.length-2];
    return labels[0] || '—';
  }catch{ return String(url).slice(0, 40); }
}
/** Strip a leading vendor prefix and ':free' suffix from a model name. */
function shortModel(name){
  if(!name) return '—';
  let s=String(name);
  s=s.replace(/^[^/]+[/]/,'');   // drop "openrouter/" etc.
  s=s.replace(/:free$/,'');      // drop ":free"
  return s || '—';
}
/**
 * Per-row provider/model chip rendered under the Reason cell so the user
 * can see at a glance which LLM produced each row (especially useful
 * for llm_error:* / unparseable rows where the model is the question).
 */
function llmMeta(row){
  const p=shortProvider(row.provider);
  const m=shortModel(row.model);
  if(p==='—' && m==='—') return '';
  const parts=[];
  if(p!=='—') parts.push('<span class="prov">'+esc(p)+'</span>');
  if(m!=='—') parts.push('<span class="model">'+esc(m)+'</span>');
  return '<div class="llm-meta">'+parts.join('<span class="sep">·</span>')+'</div>';
}
/**
 * Render a "friendly identifier" cell.
 *  - If a handle (@chat_username / @username) is set, show it as the primary
 *    blue link-styled value and the id underneath in small mono.
 *  - Otherwise show the display name (chat_title / full_name) as primary,
 *    with the id underneath.
 *  - If neither a handle nor a name is set, fall back to the raw id in mono.
 */
function idCell(handle, name, id){
  if(handle){
    return '<div class="id-cell">'+
      '<span class="primary handle">@'+esc(handle)+'</span>'+
      '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
    '</div>';
  }
  if(name){
    return '<div class="id-cell">'+
      '<span class="primary">'+esc(name)+'</span>'+
      '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
    '</div>';
  }
  return '<div class="id-cell">'+
    '<span class="secondary">id: '+esc(id==null?'—':id)+'</span>'+
  '</div>';
}
/**
 * Render the full audit row as a compact, elegant property panel.
 * Single-column flowing layout: metadata bar, identity, message bubble,
 * reason, LLM attribution, fun_response callout, raw JSON toggle.
 */
function detailsBody(row){
  const v=x=>x==null||x===''?'—':x;
  const fmtTs=(row.ts||'').replace('T',' ').replace('Z','');
  const parts=[
    // 1 — metadata bar: ts + id
    '<div class="d-meta">'+
      '<span class="d-ts">'+esc(fmtTs)+'</span>'+
      '<span class="sep">·</span>'+
      '<span class="d-id">#'+esc(v(row.id))+'</span>'+
    '</div>',
  ];
  // 2 — chat & user identity
  const chatH=row.chat_username
    ? '<span class="who-val">@'+esc(row.chat_username)+'</span>'
    : row.chat_title
      ? '<span class="who-val">'+esc(row.chat_title)+'</span>'
      : '<span class="who-val">'+esc(v(row.chat_id))+'</span>';
  const userH=row.username
    ? '<span class="who-val">@'+esc(row.username)+'</span>'
    : row.full_name
      ? '<span class="who-val">'+esc(row.full_name)+'</span>'
      : '<span class="who-val">'+esc(v(row.user_id))+'</span>';
  parts.push(
    '<div class="d-who">'+
      '<span class="d-who-item"><span class="who-key">Chat</span>'+chatH+'</span>'+
      '<span class="d-who-item"><span class="who-key">User</span>'+userH+'</span>'+
    '</div>'
  );
  // 3 — level | event | decision
  parts.push(
    '<div class="d-meta">'+
      levelBadge(row.level)+
      ' <code style="font-size:.76rem">'+esc(v(row.event))+'</code>'+
      ' <span class="sep">·</span> '+
      decisionBadge(row.decision)+
    '</div>'
  );
  // 4 — message bubble
  if(row.message_text) parts.push('<div class="d-bubble">'+esc(row.message_text)+'</div>');
  // 5 — reason line
  if(row.reason) parts.push('<div class="d-why">'+esc(row.reason)+'</div>');
  // 6 — LLM verdict + fun_response
  if(row.llm_response){
    let parsed=null;
    try{ parsed=JSON.parse(row.llm_response); }catch{}
    if(parsed && typeof parsed==='object'){
      const flagPill=parsed.flag===true
        ? '<span class="callout flag-on">flag</span>'
        : parsed.flag===false
          ? '<span class="callout flag-off">flag</span>'
          : '';
      parts.push(
        '<div class="d-ai">'+
          '<span class="ai-prov">'+esc(shortProvider(row.provider))+'</span>'+
          '<span class="ai-sep">·</span>'+
          '<span class="ai-model">'+esc(shortModel(row.model))+'</span>'+
          (flagPill?' <span class="ai-sep">·</span> '+flagPill:'')+
        '</div>'
      );
      if(parsed.fun_response){
        parts.push('<div class="d-fun">'+esc(parsed.fun_response)+'</div>');
      }
      parts.push('<details class="d-raw"><summary>raw</summary><pre>'+esc(JSON.stringify(parsed,null,2))+'</pre></details>');
    } else {
      parts.push('<div class="d-why">'+esc(v(row.llm_response))+'</div>');
    }
  } else {
    parts.push('<div class="d-why" style="font-style:italic">— no LLM call for this event</div>');
  }
  return parts.join('\\n');
}
async function loadStats(){
  const r=await fetch(base+'/api/summary?'+qs());
  if(!r.ok)return;
  const s=await r.json();
  const total=(s.by_level||[]).reduce((a,x)=>a+(x.c||0),0);
  const deletes=(s.by_event||[]).filter(x=>['flagged_deleted','video_deleted'].includes(x.event))
    .reduce((a,x)=>a+(x.c||0),0);
  const errors=(s.by_level||[]).filter(x=>x.level==='error').reduce((a,x)=>a+(x.c||0),0);
  document.getElementById('stats').innerHTML=
    '<div class="stat"><div class="num">'+total+'</div><div class="lbl">Total (filtered)</div></div>'+
    '<div class="stat"><div class="num">'+deletes+'</div><div class="lbl">Deletions</div></div>'+
    '<div class="stat"><div class="num">'+errors+'</div><div class="lbl">Errors</div></div>';
}
async function loadEvents(){
  const r=await fetch(base+'/api/events'); if(!r.ok)return;
  const evts=await r.json();
  const sel=document.getElementById('f-event');
  for(const e of evts){const o=document.createElement('option');o.value=e;o.textContent=e;sel.appendChild(o);}
}
async function loadRows(){
  const p=qs(); p.set('page',page); p.set('per_page',perPage);
  const r=await fetch(base+'/api/logs?'+p);
  const tbody=document.getElementById('rows');
  if(!r.ok){tbody.innerHTML='<tr class="error"><td colspan="9">Failed to load ('+r.status+')</td></tr>';return;}
  const d=await r.json();
  if(!d.rows.length){tbody.innerHTML='<tr class="empty"><td colspan="9">No rows match the filters.</td></tr>';}
  else{
    tbody.innerHTML=d.rows.map((row,i)=>{
      const chat=idCell(row.chat_username, row.chat_title, row.chat_id);
      const user=idCell(row.username, row.full_name, row.user_id);
      return '<tr data-i="'+i+'">'+
        '<td class="mono">'+esc((row.ts||'').replace('T',' ').replace('Z',''))+'</td>'+
        '<td>'+levelBadge(row.level)+'</td>'+
        '<td>'+esc(row.event)+'</td>'+
        '<td>'+chat+'</td>'+
        '<td>'+user+'</td>'+
        '<td>'+decisionBadge(row.decision)+'</td>'+
        '<td class="col-reason"><div class="reason">'+esc(row.reason)+'</div>'+llmMeta(row)+'</td>'+
        '<td class="col-msg"><div class="reason">'+esc(row.message_text)+'</div></td>'+
        '<td class="col-details"><button type="button" class="details-btn" data-i="'+i+'" aria-expanded="false">Details</button></td>'+
      '</tr>'+
      '<tr class="details-row" data-details-for="'+i+'" hidden><td colspan="9"><div class="details-inner">'+
        detailsBody(row)+
      '</div></td></tr>';
    }).join('');
    // Wire up details toggle buttons (event delegation on tbody).
    tbody.querySelectorAll('.details-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const i=btn.getAttribute('data-i');
        const row=tbody.querySelector('tr.details-row[data-details-for="'+i+'"]');
        const open=btn.getAttribute('aria-expanded')==='true';
        const next=!open;
        btn.setAttribute('aria-expanded', next?'true':'false');
        btn.textContent=next?'Hide':'Details';
        if(row) row.hidden=!next;
      });
    });
  }
  document.getElementById('page-info').textContent=
    'Page '+page+(d.has_more?' (more)':'');
  document.getElementById('prev').disabled=page<=1;
  document.getElementById('next').disabled=!d.has_more;
}
function apply(){page=1;loadRows();loadStats();}
document.getElementById('apply').addEventListener('click',apply);
document.getElementById('prev').addEventListener('click',()=>{if(page>1){page--;loadRows();}});
document.getElementById('next').addEventListener('click',()=>{if(!document.getElementById('next').disabled){page++;loadRows();}});
document.getElementById('export').addEventListener('click',()=>{location.href=base+'/export.csv?'+qs();});
/* Sortable column headers: click toggles asc/desc, client-side sort of the
   current page rows. Sorted columns get aria-sort. */
let sortKey=null, sortAsc=true;
const _colIdx={ts:0,level:1,event:2,chat_username:3,user_id:4,decision:5,reason:6,message_text:7};
document.querySelectorAll('th[data-k]').forEach(th=>{
  th.addEventListener('click',()=>{
    const k=th.getAttribute('data-k');
    if(sortKey===k){sortAsc=!sortAsc;}else{sortKey=k;sortAsc=true;}
    const dir=sortAsc?1:-1;
    const idx=_colIdx[k];
    const tbody=document.getElementById('rows');
    const els=Array.from(tbody.children);
    const pairs=[];
    for(let i=0;i<els.length;i+=2){
      const row=els[i];
      const detail=els[i+1]&&els[i+1].classList.contains('details-row')?els[i+1]:null;
      pairs.push({row,detail});
    }
    pairs.sort((a,b)=>{
      const ca=(a.row.cells[idx]?.textContent||'').trim();
      const cb=(b.row.cells[idx]?.textContent||'').trim();
      return ca.localeCompare(cb,undefined,{numeric:true,sensitivity:'base'})*dir;
    });
    tbody.innerHTML='';
    pairs.forEach(p=>{tbody.appendChild(p.row);if(p.detail)tbody.appendChild(p.detail);});
    document.querySelectorAll('th[data-k]').forEach(h=>h.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort',sortAsc?'ascending':'descending');
  });
});
['f-level','f-event','f-decision','f-chat','f-user','f-from','f-to','f-q'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')apply();});
});
loadEvents();loadStats();loadRows();
</script></body></html>`;
  return htmlResponse(html);
}
