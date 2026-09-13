/**
 * fetch() with a hard timeout via AbortController. Workers have no global
 * request deadline for cron work, so long-running pipelines bound each
 * outbound call themselves.
 */

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
