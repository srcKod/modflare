/**
 * Telegram-HTML sanitizer: reduces arbitrary HTML (LLM output or admin editor
 * input) to the tag allowlist Telegram parse-mode supports, escapes stray
 * entities, and caps length. Shared by every feature that posts formatted
 * content to Telegram.
 */

/* ------------------------------------------------------------------ */
/* Telegram-HTML sanitizer                                             */
/* ------------------------------------------------------------------ */

const TG_TAG_ALIASES: Record<string, string> = {
  strong: 'b',
  em: 'i',
  ins: 'u',
  strike: 's',
  del: 's',
};

/**
 * Sanitize arbitrary HTML (LLM or admin editor) down to the Telegram-HTML
 * allowlist: <b> <i> <u> <s> <a href> <code> <pre> <blockquote>.
 * Unknown tags are unwrapped (their text survives); stray < > & are escaped;
 * link hrefs are restricted to http(s)/tg schemes. Output is capped.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function sanitizeTelegramHtml(input: string, limit = 3900): string {
  const src = decodeEntities(input);
  let out = '';
  const stack: string[] = [];
  let i = 0;
  const n = src.length;

  const pushText = (s: string) => {
    if (out.length >= limit) return;
    const escaped = s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out += escaped.slice(0, limit - out.length);
  };

  while (i < n && out.length < limit) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    const close = src.indexOf('>', lt);
    if (close < 0) {
      pushText(src.slice(lt)); // malformed '<' — treat the rest as text
      break;
    }
    const tagSrc = src.slice(lt + 1, close);
    const isClosing = tagSrc.startsWith('/');
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tagSrc);
    const rawName = (nameMatch?.[1] ?? '').toLowerCase();
    i = close + 1;

    if (!rawName) continue;
    const name = TG_TAG_ALIASES[rawName] ?? rawName;
    if (!['b', 'i', 'u', 's', 'a', 'code', 'pre', 'blockquote'].includes(name)) {
      continue; // unknown tag: unwrap (text already kept)
    }

    if (isClosing) {
      const openIdx = stack.lastIndexOf(name);
      if (openIdx >= 0) {
        // close any tags opened after it (auto-balance), then it
        while (stack.length > openIdx) {
          out += `</${stack.pop()}>`;
        }
      }
      continue;
    }

    if (rawName === 'a') {
      const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagSrc);
      const href = (hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? '').trim();
      if (/^(https?:\/\/|tg:\/\/)/i.test(href)) {
        // Normalize (already-escaped entities → raw) then escape once, so the
        // href is always exactly one layer of HTML escaping for Telegram.
        const hrefSafe = href
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&/g, '&amp;')
          .replace(/"/g, '%22');
        out += `<a href="${hrefSafe}">`;
        stack.push('a');
      }
      continue;
    }

    out += `<${name}>`;
    stack.push(name);
  }
  // Auto-close anything left open.
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** Rough rendered-text length (tags stripped) for limit messaging. */
export function renderedLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').length;
}

