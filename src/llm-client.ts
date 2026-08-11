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
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 30000;

  const content: ContentPart[] = [];

  if (text) {
    content.push({ type: 'text', text });
  } else if (media.length === 0) {
    // Nothing to analyze — not actionable.
    return { flag: false, reason: 'empty message' };
  }

  // Only photo / GIF / image-document parts reach the LLM (videos are removed
  // by policy before this). All can be sent as image_url.
  for (const part of media) {
    content.push({ type: 'image_url', image_url: { url: part.url } });
  }

  const body = {
    model: env.MODEL_NAME,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content },
    ],
    temperature: 0,
    stream: false,
  };

  const endpoint = `${env.OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(
        `LLM returned ${res.status}: ${res.statusText} ${errText.slice(0, 300)}`,
      );
      return { flag: false, reason: `llm_error:${res.status}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    if (!raw) {
      // Empty content is usually a quota/refusal/proxy issue. Dump the full
      // response so it's visible in the dev log for debugging.
      console.error(`LLM returned 200 but no message content. Full response: ${JSON.stringify(json).slice(0, 600)}`);
    }
    return parseModeration(raw, raw);
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