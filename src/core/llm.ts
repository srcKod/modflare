/**
 * Core LLM client: one OpenAI-compatible chat-completions caller, configured
 * per named profile. Features describe *which* endpoint/model/options to use
 * (a profile); this module owns the transport concerns — timeouts, response
 * format fallback, extra-body merge, error normalization — once, for all.
 */

/** Content parts accepted in a message (string, or multimodal parts array). */
export type LlmContent = string | unknown[];

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: LlmContent;
}

/** One OpenAI-compatible endpoint configuration. */
export interface LlmProfile {
  /** Base URL without trailing slash. */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** Defaults to 0 (deterministic) when unset. */
  temperature?: number;
  /** Send `response_format: json_object` (model-dependent). */
  jsonMode?: boolean;
  /** Raw JSON object merged into the request body (thinking toggles etc.). */
  extraBody?: string;
}

export type LlmResult =
  | { ok: true; raw: string; finishReason?: string }
  | { ok: false; error: string; detail?: string };

/**
 * Run a chat completion. Never throws: failures come back as
 * `{ ok: false, error }` with `llm_error:<status>` / `llm_timeout` /
 * `llm_empty` so callers can map them onto their own failure policy.
 */
export async function chatCompletion(
  profile: LlmProfile,
  messages: LlmMessage[],
): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    temperature: profile.temperature ?? 0,
    stream: false,
    max_tokens: profile.maxTokens,
  };
  if (profile.jsonMode) body.response_format = { type: 'json_object' };
  if (profile.extraBody?.trim()) {
    try {
      const extra = JSON.parse(profile.extraBody);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        Object.assign(body, extra);
      } else {
        console.error('LLM_EXTRA_BODY_JSON must be a JSON object; ignoring');
      }
    } catch {
      console.error('LLM extra body invalid JSON; ignoring');
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const call = (payload: Record<string, unknown>) =>
      fetch(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${profile.apiKey}`,
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

    let res = await call(body);
    // Some endpoints 400 on response_format — retry once without it.
    if (res.status === 400 && profile.jsonMode) {
      const retry = { ...body };
      delete retry.response_format;
      res = await call(retry);
    }
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 300);
      console.error(`LLM returned ${res.status}: ${errText}`);
      return { ok: false, error: `llm_error:${res.status}`, detail: errText };
    }

    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    } | null;
    const raw = json?.choices?.[0]?.message?.content ?? '';
    if (!raw) {
      console.error('LLM returned 200 with empty content');
      return { ok: false, error: 'llm_empty' };
    }
    return { ok: true, raw, finishReason: json?.choices?.[0]?.finish_reason };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      ok: false,
      error: name === 'AbortError' ? 'llm_timeout' : 'llm_error',
    };
  } finally {
    clearTimeout(timer);
  }
}
