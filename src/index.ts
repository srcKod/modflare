/**
 * Worker shell: collects feature manifests and wires the three entrypoints
 * (webhook fetch, scheduled crons, admin panel). Contains no feature logic —
 * see the manifests under the features folder and core/router.ts.
 */

import { makeLogger, pruneExpiredAudit } from './core/logger';
import { adminRoutesOf, dispatchCron, dispatchUpdate } from './core/router';
import type { FeatureManifest } from './core/router';
import { handleAdmin } from './core/admin';
import type { Env, TelegramUpdate } from './core/types';
import { moderationFeature } from './features/moderation';

/** All worker features. New features register here and nowhere else. */
const FEATURES: FeatureManifest[] = [moderationFeature];

// 1x1 transparent PNG (67 bytes) used as the /favicon.ico response so
// browser tab requests don't surface 405 errors in the dev console.
const FAVICON_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Return the 1x1 transparent PNG as the favicon response. */
function faviconResponse(): Response {
  return new Response(FAVICON_PNG, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Admin panel routes (login, panel, feature-contributed APIs). Only
    // active when ADMIN_PANEL_TOKEN is set; otherwise falls through.
    const adminRes = await handleAdmin(
      request,
      env,
      adminRoutesOf(FEATURES),
    );
    if (adminRes) return adminRes;

    // Browsers auto-request /favicon.ico on every page load; answer with the
    // tiny PNG so the dev console isn't spammed with 405s.
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') {
      return faviconResponse();
    }

    // Only accept POST webhook deliveries.
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Optional origin validation.
    if (env.WEBHOOK_SECRET_TOKEN) {
      const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (provided !== env.WEBHOOK_SECRET_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Fire-and-forget the feature chain so we can return 200 immediately;
    // the work continues in the background via waitUntil. Telegram retries
    // non-200 webhooks, so the fast 200 matters even when work fails later.
    void ctx.waitUntil(
      dispatchUpdate(FEATURES, env, update, makeLogger(env)),
    );

    return new Response('OK', { status: 200 });
  },

  /**
   * Cron handler. Features claim their own expressions via their manifests;
   * unclaimed expressions fall back to the audit-retention prune (safe
   * default so an unknown cron can never run unbounded work).
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const job = await dispatchCron(FEATURES, env, event.cron);
    if (job) {
      await job();
      return;
    }
    const removed = await pruneExpiredAudit(env);
    makeLogger(env).info('audit_prune', {
      removed: removed < 0 ? null : removed,
      retentionDays: env.LOG_RETENTION_DAYS || '30',
    });
  },
};
