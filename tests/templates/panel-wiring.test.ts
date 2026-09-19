import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard: the format-wrap handler must stay scoped to [data-wrap]
// buttons. An unscoped '.dg-toolbar button' selector catches the direction
// buttons too (they carry data-dg-dir, not data-wrap), and the wrap path
// then string-concats tag=null into literal <null> tags in the draft.

const ROOT = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('panel toolbar wiring scope', () => {
  it('format-wrap handler only touches [data-wrap] buttons', () => {
    const src = read('src/templates/js/app.js');
    expect(src).toContain('.dg-toolbar button[data-wrap]');
    expect(src).not.toMatch(/querySelectorAll\('\.dg-toolbar button'\)/);
  });

  it('direction buttons carry data-dg-dir (never data-wrap)', () => {
    // The buttons themselves live in admin.html; app.js only queries them.
    const html = read('src/templates/admin.html');
    const dirButtons = html.match(/data-dg-dir="(ltr|rtl|auto)"/g) ?? [];
    expect(dirButtons.length).toBe(3);
    expect(html).not.toMatch(/data-dg-dir="[^"]*"[^>]*data-wrap/);
    expect(html).not.toMatch(/data-wrap="[^"]*"[^>]*data-dg-dir/);
  });
});
