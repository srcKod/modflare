import type { Env } from './types';

/** Log levels in ascending severity order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ordered severity map used to filter by LOG_LEVEL. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Whether the audit logger is enabled, from LOG_ENABLED env var.
 * Accepts 'true'/'1'/'yes'. Defaults to true (logging on) so existing
 * deployments keep working without setting anything.
 */
export function isLogEnabled(env: Env): boolean {
  const v = (env.LOG_ENABLED || '').trim().toLowerCase();
  if (v === '') return true; // default on
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Resolve the configured minimum log level from LOG_LEVEL env var.
 * Defaults to 'info'. Invalid values fall back to 'info'.
 */
export function resolveLevel(env: Env): LogLevel {
  const v = (env.LOG_LEVEL || 'info').trim().toLowerCase();
  return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
}

/**
 * A structured audit logger backed by D1.
 *
 * Each log call writes a JSON row to the `audit_log` table with the event
 * kind, timestamps, chat/user context, and any content/LLM response. Writes
 * are fire-and-forget (not awaited by the caller) so logging never blocks or
 * fails the moderation pipeline — a logging error is swallowed.
 *
 * Level filtering: only entries at or above the configured LOG_LEVEL are
 * written, so you can run `debug` during development and `warn`/`error` in
 * production to keep the audit trail small.
 */
export function makeLogger(env: Env) {
  const minLevel = resolveLevel(env);
  const db: D1Database | undefined = env.DB;
  const enabled = isLogEnabled(env);

  async function write(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    // Hard fail-open: without D1 configured, logs are no-ops.
    if (!enabled) return;
    if (!db) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    const row: {
      ts: string;
      level: LogLevel;
      event: string;
      provider?: unknown;
      model?: unknown;
      chat_id?: unknown;
      chat_username?: unknown;
      chat_title?: unknown;
      user_id?: unknown;
      username?: unknown;
      full_name?: unknown;
      decision?: unknown;
      reason?: unknown;
      message_text?: unknown;
      llm_response?: unknown;
      extra?: unknown;
    } = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };

    try {
      await db
        .prepare(
          `INSERT INTO audit_log (
             ts, level, event, provider, model,
             chat_id, chat_username, chat_title,
             user_id, username, full_name, decision, reason,
             message_text, llm_response, extra
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.ts,
          level,
          event,
          row.provider ?? null,
          row.model ?? null,
          row.chat_id ?? null,
          row.chat_username ?? null,
          row.chat_title ?? null,
          row.user_id ?? null,
          row.username ?? null,
          row.full_name ?? null,
          row.decision ?? null,
          row.reason ?? null,
          row.message_text ?? null,
          row.llm_response ?? null,
          row.extra ? JSON.stringify(row.extra) : null,
        )
        .run();
    } catch (err) {
      // Logging must never break moderation. Swallow and report to console.
      console.error(`audit log write failed (${event}): ${err}`);
    }
  }

  return {
    debug: (event: string, fields?: Record<string, unknown>) =>
      write('debug', event, fields),
    info: (event: string, fields?: Record<string, unknown>) =>
      write('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) =>
      write('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) =>
      write('error', event, fields),
  };
}

/** Type of the handle returned by makeLogger. */
export type AuditLogger = ReturnType<typeof makeLogger>;