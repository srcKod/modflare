/**
 * Moderation LLM usage: prompt assembly, routing (multimodal vs text-only
 * model), and tolerant response parsing. The transport is core/llm.ts —
 * this module only decides WHAT to ask and HOW to read the answer.
 *
 * Failure policy: fail-open. Any LLM/network/parse error yields
 * `{ flag: false }` so moderation never deletes on a mistake.
 */

import { chatCompletion } from '../../core/llm';
import type { LlmProfile } from '../../core/llm';
import type { Env } from '../../core/types';
import type {
  JsonModerationReply,
  MediaPart,
  ModerationParse,
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
 * Resolve the model that will handle a moderation request: media (image
 * parts) go to the multimodal MODEL_NAME; plain text goes to the cheap,
 * fast TEXT_MODEL, falling back to MODEL_NAME when TEXT_MODEL is unset.
 * Single source of truth shared by the LLM call and the audit logger, so
 * the D1 row always names the model that actually processed the message.
 */
export function resolveModel(env: Env, hasMedia: boolean): string {
  return hasMedia ? env.MODEL_NAME : env.TEXT_MODEL || env.MODEL_NAME;
}

/** Build the moderation profile: routing + knobs live in env, not code. */
function moderationProfile(env: Env, isImage: boolean): LlmProfile {
  return {
    baseUrl: env.OPENAI_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.OPENAI_API_KEY,
    model: resolveModel(env, isImage),
    // Moderation-scoped output cap (plan: 400). A missing var falls back to
    // the same 400 — never the multi-thousand digest-scale default.
    maxTokens: Number(env.LLM_MAX_TOKENS) || 400,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 60000,
    temperature: 0,
    jsonMode: env.LLM_RESPONSE_FORMAT === 'json',
    // Image path uses LLM_EXTRA_BODY_JSON; text path prefers its own override.
    extraBody: isImage
      ? env.LLM_EXTRA_BODY_JSON
      : env.TEXT_EXTRA_BODY_JSON || env.LLM_EXTRA_BODY_JSON,
  };
}

/**
 * Send text + media to the configured endpoint and decide whether the
 * content should be flagged/removed. Fails OPEN: on any error or malformed
 * response we return `{ flag: false }` so a message is never deleted by mistake.
 */
export async function moderateContent(
  env: Env,
  text: string,
  media: MediaPart[],
): Promise<ModerationResult> {
  const wantFun = isFunResponseEnabled(env);
  const language = env.FUNRESPONSE_LANGUAGE?.trim() || 'English';
  const dialect = env.FUNRESPONSE_DIALECT?.trim();
  const langHint = dialect
    ? `Language: ${language} (dialect: ${dialect})`
    : `Language: ${language}`;
  const prompt =
    (env.MODERATION_PROMPT?.trim() || DEFAULT_PROMPT) +
    (wantFun ? FUN_RESPONSE_ADDENDUM + `\n${langHint}` : '');

  // One user message whose content is either plain text or multimodal parts.
  // Parts must be well-shaped: the endpoint rejects bare strings inside a
  // content array (AiError 3030), so text rides in a {type:'text'} part.
  const parts: Record<string, unknown>[] = [];
  if (text) parts.push({ type: 'text', text });
  else if (media.length === 0) {
    // Nothing to analyze — not actionable.
    return { flag: false, reason: 'empty message' };
  }

  // Only photo / GIF / image-document parts reach the LLM (videos are removed
  // by policy before this). All are pre-downloaded as base64 data URLs so the
  // model never sees a public URL (no token leak, no URL-domain allowlist).
  for (const part of media) {
    parts.push({ type: 'image_url', image_url: { url: part.dataUrl } });
  }

  const isImage = media.length > 0;
  const llm = await chatCompletion(moderationProfile(env, isImage), [
    { role: 'system', content: prompt },
    { role: 'user', content: parts },
  ]);
  if (!llm.ok) {
    // Normalize transport errors onto the audit reasons callers know.
    const reason = llm.error.startsWith('llm_error:')
      ? llm.error
      : llm.error === 'llm_timeout'
        ? 'llm_timeout'
        : 'llm_error';
    return { flag: false, reason, llmResponse: '' };
  }
  return parseModeration(llm.raw, llm.raw);
}

/**
 * Structured read of a raw model reply. The moderation parser and the audit
 * CSV export share this so both agree on what the model actually said. See
 * ModerationParse (types.ts) for the status taxonomy; only fields the reply
 * actually carries are set — notably `plain` carries flag=true with no
 * synthetic reason.
 */
export function parseModerationDetailed(raw: string): ModerationParse {
  const stripped = raw.trim();
  if (!stripped) return { status: 'empty' };

  const fromParsed = (
    parsed: JsonModerationReply,
    status: 'json' | 'json_in_prose',
  ): ModerationParse => {
    const flag =
      parsed.flag === true ||
      parsed.flag === 'true' ||
      parsed.flag === 'yes' ||
      parsed.flag === 1;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

    let funResponse: string | undefined;
    const f = parsed.fun_response;
    if (typeof f === 'string' && f.trim()) funResponse = f.trim();

    const out: ModerationParse = { status, flag, reason };
    if (funResponse) out.funResponse = funResponse;
    return out;
  };

  // Only a JSON object is a moderation reply — bare JSON scalars (a model
  // replying just `true` / `false` / "yes") fall through to the plain-token
  // check below, matching its documented intent.
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') {
      return fromParsed(parsed as JsonModerationReply, 'json');
    }
  } catch {
    /* not strict JSON — try to extract */
  }

  // Extract first JSON object anywhere in the text.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return fromParsed(
        JSON.parse(match[0]) as JsonModerationReply,
        'json_in_prose',
      );
    } catch {
      /* fall through */
    }
  }

  // Plain-token fallback: lines that read "true"/"yes"/"flag".
  if (/flag\s*[:=]\s*(true|1|yes)|^\s*(true|yes)\s*$/i.test(stripped)) {
    return { status: 'plain', flag: true };
  }

  return { status: 'unparseable' };
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
  const parsed = parseModerationDetailed(raw);
  switch (parsed.status) {
    case 'json':
    case 'json_in_prose': {
      const base: ModerationResult = {
        flag: parsed.flag ?? false,
        reason: parsed.reason ?? '',
        llmResponse,
      };
      return parsed.funResponse
        ? { ...base, funResponse: parsed.funResponse }
        : base;
    }
    case 'plain':
      return { flag: true, reason: 'flagged', llmResponse };
    default:
      if (raw.trim()) {
        // Non-empty but unparseable: log so we can see what the model said.
        console.error(`LLM reply unparseable: ${raw.trim().slice(0, 300)}`);
      }
      return { flag: false, reason: 'unparseable', llmResponse };
  }
}
