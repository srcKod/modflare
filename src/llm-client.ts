import type {
  Env,
  JsonModerationReply,
  MediaPart,
  ModerationResult,
} from './types';

/** Enable/disable check for the funny response (ENABLE_FUNRESPONSE). */
function isFunResponseEnabled(env: Env): boolean {
  const v = env.ENABLE_FUNRESPONSE?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

const DEFAULT_PROMPT = `You are a strict content moderator for a Telegram group.
Analyze the following message text and any attached media.
Flag content that contains any of:
1) hate speech or harassment,
2) suspicious, malicious, or phishing links,
3) pornographic, gory, or violent media,
4) spam or scam material,
5) any other content clearly inappropriate for a public group.

Respond with ONLY a JSON object of the form:
{"flag": true|false, "reason": "short explanation"}
where "flag" is true only if the content should be removed. Never include extra text.`;

const FUN_RESPONSE_ADDENDUM = `\nAdditionally, when flag is true and you are asked to, include a field
"fun_response": a short, kind, HARMLESS and funny one-liner to the person
whose message was removed. It must be humorous but never mean, insulting,
threatening, or sarcastic toward them; warm and light-hearted, 1-2 short
sentences (under 200 chars), written in the requested language — and in the
requested dialect if one is given (e.g. a specific Arabic dialect). Must not
blame them for the removed content. Return an empty string when flag is false.`;

/**
 * OpenAI-compatible content part types used in multimodal requests.
 * Types are intentionally loose so they pass through to any provider.
 */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Send text + media to an OpenAI-compatible chat completions endpoint and ask
 * it to decide whether the content should be flagged/removed.
 *
 * Fails OPEN by default: on any error or malformed response we return
 * { flag: false } so the moderation logic never deletes a message by mistake.
 */
export async function moderateContent(
  env: Env,
  text: string,
  media: MediaPart[],
): Promise<ModerationResult> {
  const wantFun = isFunResponseEnabled(env);
  const language = env.FUNRESPONSE_LANGUAGE?.trim() || 'English';
  const dialect = env.FUNRESPONSE_DIALECT?.trim();
  const langHint =
    dialect
      ? `Language: ${language} (dialect: ${dialect})`
      : `Language: ${language}`;
  const prompt =
    (env.MODERATION_PROMPT?.trim() || DEFAULT_PROMPT) +
    (wantFun ? FUN_RESPONSE_ADDENDUM + `\n${langHint}` : '');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 60000;
  const maxTokens = Number(env.LLM_MAX_TOKENS) || 2048;

  const content: ContentPart[] = [];

  if (text) {
    content.push({ type: 'text', text });
  } else if (media.length === 0) {
    // Nothing to analyze — not actionable.
    return { flag: false, reason: 'empty message' };
  }

  // Only photo / GIF / image-document parts reach the LLM (videos are removed
  // by policy before this). All are pre-downloaded as base64 data URLs so the
  // model never sees a public URL (no token leak, no URL-domain allowlist).
  for (const part of media) {
    content.push({ type: 'image_url', image_url: { url: part.dataUrl } });
  }

  // Route by content: images (media present) use the multimodal MODEL_NAME;
  // plain text (the common spam/link case) can fall back to a cheap, fast
  // text-only TEXT_MODEL. Keeps the routing inside the worker from the data
  // it already has — no client-supplied flag, no gateway dynamic route.
  // Falls back to MODEL_NAME for both when TEXT_MODEL is unset.
  const isImage = media.length > 0;
  const model = isImage ? env.MODEL_NAME : env.TEXT_MODEL || env.MODEL_NAME;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content },
    ],
    temperature: 0,
    stream: false,
    max_tokens: maxTokens,
  };

  // Opt-in structured output. Off by default: not every OpenAI-compatible
  // endpoint accepts `response_format` (some return 400), and parseModeration
  // already tolerates JSON inside code fences / prose. Set LLM_RESPONSE_FORMAT
  // to "json" only when the configured model supports strict JSON output.
  if (env.LLM_RESPONSE_FORMAT === 'json') {
    body.response_format = { type: 'json_object' };
  }

  // Generic provider/model escape hatch: merge arbitrary JSON into the request
  // body. Lets you send the correct thinking-toggle param for whatever model is
  // configured. The image path (MODEL_NAME) uses LLM_EXTRA_BODY_JSON; the text
  // path (TEXT_MODEL) uses TEXT_EXTRA_BODY_JSON and falls back to the shared
  // LLM_EXTRA_BODY_JSON when unset — so both models get reasoning handled out
  // of the box, and each can be overridden independently later.
  // Examples: {"thinking":{"type":"disabled"}} for Z.ai GLM,
  // {"enable_thinking":false} for Qwen3, {"reasoning_effort":"none"} for
  // OpenAI. Invalid JSON is logged and ignored so moderation never breaks.
  const extraBodyJson = isImage
    ? env.LLM_EXTRA_BODY_JSON
    : env.TEXT_EXTRA_BODY_JSON || env.LLM_EXTRA_BODY_JSON;
  if (extraBodyJson?.trim()) {
    try {
      const extra = JSON.parse(extraBodyJson);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        Object.assign(body, extra);
      } else {
        console.error(
          `${isImage ? 'LLM_EXTRA_BODY_JSON' : 'TEXT_EXTRA_BODY_JSON'} must be a JSON object; ignoring`,
        );
      }
    } catch (err) {
      console.error(
        `${isImage ? 'LLM_EXTRA_BODY_JSON' : 'TEXT_EXTRA_BODY_JSON'} invalid JSON: ${String(err)}`,
      );
    }
  }

  const endpoint = `${env.OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    };
    const res = await fetch(endpoint, init);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(
        `LLM returned ${res.status}: ${res.statusText} ${errText.slice(0, 300)}`,
      );
      return { flag: false, reason: `llm_error:${res.status}` };
    }

    // Non-streaming (stream:false) — plain JSON chat/completions response.
    // This is the most widely supported OpenAI-compatible shape; when the
    // provider includes a reasoning/thinking phase, the final `content` still
    // arrives here once the answer is produced.
    let content = '';
    try {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
      };
      content = json.choices?.[0]?.message?.content ?? '';
    } catch (jsonErr) {
      const text = await res.text().catch(() => '');
      console.error(`LLM non-json response: ${text.slice(0, 300)}`);
      return { flag: false, reason: 'llm_error', llmResponse: text };
    }

    if (!content) {
      console.error('LLM returned 200 with empty content');
    }
    return parseModeration(content, content);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'AbortError';
    console.error(`LLM call failed${timedOut ? ' (timeout)' : ''}: ${err}`);
    return {
      flag: false,
      reason: timedOut ? 'llm_timeout' : 'llm_error',
      llmResponse: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the model's reply into a ModerationResult. Tolerates a JSON object,
 * a JSON object embedded in prose, or a graceful fallback to a plain flag line.
 * Anything unparsed defaults to SAFE (fail-open).
 *
 * `llmResponse` is the raw model text, preserved for the audit log.
 */
export function parseModeration(
  raw: string,
  llmResponse = raw,
): ModerationResult {
  const stripped = raw.trim();

  try {
    const parsed = JSON.parse(stripped) as JsonModerationReply;
    return toResult(parsed, llmResponse);
  } catch {
    /* not strict JSON — try to extract */
  }

  // Extract first JSON object anywhere in the text.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return toResult(JSON.parse(match[0]) as JsonModerationReply, llmResponse);
    } catch {
      /* fall through */
    }
  }

  // Plain-token fallback: lines that read "true"/"yes"/"flag".
  if (/flag\s*[:=]\s*(true|1|yes)|^\s*(true|yes)\s*$/i.test(stripped)) {
    return { flag: true, reason: 'flagged', llmResponse };
  }

  if (stripped) {
    // Non-empty but unparseable: log so we can see what the model said.
    console.error(`LLM reply unparseable: ${stripped.slice(0, 300)}`);
  }
  return { flag: false, reason: 'unparseable', llmResponse };
}

function toResult(
  parsed: JsonModerationReply,
  llmResponse: string,
): ModerationResult {
  const flag =
    parsed.flag === true ||
    parsed.flag === 'true' ||
    parsed.flag === 'yes' ||
    parsed.flag === 1;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  let funResponse: string | undefined;
  const f = parsed.fun_response;
  if (typeof f === 'string' && f.trim()) funResponse = f.trim();

  const base: ModerationResult = { flag, reason, llmResponse };
  return funResponse ? { ...base, funResponse } : base;
}