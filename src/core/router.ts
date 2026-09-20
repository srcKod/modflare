/**
 * Feature manifest + dispatch registries.
 *
 * Features plug into the worker by exporting a manifest; src/index.ts collects
 * them and builds the three entrypoints (webhook fetch, scheduled crons, admin
 * API) without knowing any feature's internals.
 *
 * Ordering contract: update handlers run lowest `priority` first and a `true`
 * return short-circuits the chain — features that must pre-empt others (e.g.
 * analytics capture before moderation) declare a lower priority explicitly.
 */

import type { AuditLogger } from './logger';
import type { Env, TelegramUpdate } from './types';

/** A scheduled job. `expr` must match a cron in [triggers] (wrangler.toml). */
export interface CronRoute {
  expr: string;
  handler: (env: Env) => Promise<void>;
}

/** The update kinds a handler can consume. */
export type UpdateKind =
  | 'message'
  | 'edited_message'
  | 'message_reaction'
  | 'message_reaction_count';

export interface UpdateRoute {
  kinds: UpdateKind[];
  /** Lower runs first; returning true short-circuits lower-priority handlers. */
  priority: number;
  handler: (
    env: Env,
    update: TelegramUpdate,
    logger: AuditLogger,
  ) => Promise<boolean>;
}

/** A panel API route, mounted under the admin panel path (auth enforced). */
export interface AdminRoute {
  method: 'GET' | 'POST';
  /** Exact path relative to the panel base, e.g. '/api/logs'. */
  rest?: string;
  /** Prefix match for parameterized paths — the handler parses the rest. */
  prefix?: string;
  handler: (request: Request, env: Env) => Promise<Response>;
}

/** Everything a feature contributes to the worker shell. */
export interface FeatureManifest {
  name: string;
  crons?: CronRoute[];
  updates?: UpdateRoute[];
  adminRoutes?: AdminRoute[];
}

/** Derive the update kind present on an update object (first match wins). */
export function updateKind(update: TelegramUpdate): UpdateKind | null {
  if (update.message) return 'message';
  if (update.edited_message) return 'edited_message';
  const rec = update as unknown as Record<string, unknown>;
  if ('message_reaction' in rec && rec.message_reaction) return 'message_reaction';
  if ('message_reaction_count' in rec && rec.message_reaction_count)
    return 'message_reaction_count';
  return null;
}

/**
 * Run every registered update handler whose kinds include this update's kind,
 * lowest priority first, until one returns true (handled). Returns true when
 * some handler consumed the update.
 */
export async function dispatchUpdate(
  manifests: FeatureManifest[],
  env: Env,
  update: TelegramUpdate,
  logger: AuditLogger,
): Promise<boolean> {
  const kind = updateKind(update);
  if (!kind) return false;

  const routes = manifests
    .flatMap((m) => m.updates ?? [])
    .filter((r) => r.kinds.includes(kind))
    .sort((a, b) => a.priority - b.priority);

  for (const route of routes) {
    if (await route.handler(env, update, logger)) return true;
  }
  return false;
}

/** Run the cron handler matching `expr`; null when no feature claimed it. */
export async function dispatchCron(
  manifests: FeatureManifest[],
  env: Env,
  expr: string,
): Promise<(() => Promise<void>) | null> {
  const route = manifests
    .flatMap((m) => m.crons ?? [])
    .find((r) => r.expr === expr);
  if (!route) return null;
  return () => route.handler(env);
}

/** All admin API routes contributed by features, in registration order. */
export function adminRoutesOf(manifests: FeatureManifest[]): AdminRoute[] {
  return manifests.flatMap((m) => m.adminRoutes ?? []);
}
