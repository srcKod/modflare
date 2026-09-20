import { describe, expect, it } from 'vitest';
import {
  normalizeBreaks,
  sanitizeTelegramHtml,
} from '../../src/shared/telegram-html';

// Models emit inconsistent block separation (\n vs \n\n vs \r\n) and the
// channel post used to inherit it — entries ran together whenever the model
// skipped blank lines. normalizeBreaks makes every junction exactly one
// empty line, applied to LLM output in the pipeline (never to hand edits).

describe('normalizeBreaks', () => {
  it('upgrades single newlines between blocks to a blank line', () => {
    expect(normalizeBreaks('<b>T</b>\n<b>A</b> summary\n<b>B</b> more')).toBe(
      '<b>T</b>\n\n<b>A</b> summary\n\n<b>B</b> more',
    );
  });

  it('collapses blank runs and CRLF to exactly one blank line', () => {
    expect(normalizeBreaks('a\r\n\r\n\r\nb\n\n\nc')).toBe('a\n\nb\n\nc');
  });

  it('trims leading/trailing blanks and trailing spaces', () => {
    expect(normalizeBreaks('\n  \nkeep  \n')).toBe('keep');
  });

  it('leaves already-correct spacing untouched', () => {
    const good = '<b>T</b>\n\nitem one\n\nitem two';
    expect(normalizeBreaks(good)).toBe(good);
  });

  it('end-to-end: sanitized model output normalizes before RTL marks', () => {
    const raw = '<b>Hi</b>\nitem <a href="https://example.com/x"><i>src</i></a>';
    const body = sanitizeTelegramHtml(raw);
    expect(normalizeBreaks(body)).toBe(
      '<b>Hi</b>\n\nitem <a href="https://example.com/x"><i>src</i></a>',
    );
  });
});
