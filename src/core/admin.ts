/**
 * Admin panel shell: auth (HMAC-signed cookie), static assets, and routing.
 *
 * The shell owns the security model and page chrome; features contribute API
 * routes through their manifest (see core/router.ts AdminRoute), which are
 * mounted here behind the same auth. Security model:
 *  - Disabled entirely unless ADMIN_PANEL_TOKEN is set.
 *  - Served under a configurable path (ADMIN_PANEL_PATH, default /admin) so a
 *    random path hides it from casual discovery.
 *  - Login via a username-less token form; on success a short-lived, HMAC-signed,
 *    HttpOnly + Secure + SameSite cookie is set. No session table needed.
 *
 * Routes (all under ADMIN_PANEL_PATH):
 *   GET/POST <path>/login|logout -> auth
 *   GET  <path>                  -> login page or panel HTML
 *   GET  <path>/style.css|app.js -> panel assets (cookie-gated)
 *   <feature routes>             -> method+rest matched behind auth
 */

import type { AdminRoute } from './router';
import type { Env } from './types';
import LOGIN_HTML from '../templates/login.html';
import PANEL_HTML from '../templates/admin.html';
import STYLE_CSS from '../templates/css/style.css';
import APP_JS from '../templates/js/app.js';

const DEFAULT_PATH = '/admin';
const DEFAULT_TTL_SECONDS = 43200; // 12h
const COOKIE_NAME = 'adm';

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
  featureRoutes: AdminRoute[],
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

  // Feature-contributed API routes (method + exact rest match).
  const route = featureRoutes.find(
    (r) => r.method === request.method && r.rest === rest,
  );
  if (route) return route.handler(request, env);

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

/**
 * CSRF guard for state-changing panel endpoints: a cross-site page can't forge
 * our requests because a browser always attaches its own Origin, and a forged
 * Origin won't match the panel host. The panel's own JS sends same-origin
 * fetches (Origin = panel host) implicitly; curl-style clients must send the
 * panel URL as Origin explicitly. Requests without an Origin are rejected —
 * same-site form posts always carry one in practice.
 */
export function csrfOk(request: Request): boolean {
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function base64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/* ------------------------------------------------------------------ */
/* Small response helpers + pages                                      */
/* ------------------------------------------------------------------ */

export function json(data: unknown, status = 200): Response {
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
