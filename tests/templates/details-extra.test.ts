import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The audit Details panel must surface the structured `extra` context
// (slot, engines, hints…) — without it a warning like engines_failed shows
// a bare code and the stored diagnosis stays invisible. The panel has no JS
// harness, so these lock the wiring at the source level (same pattern as
// the toolbar-scope guard): the parse, the kv render, and the call sites.

const ROOT = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('audit Details panel renders extra context', () => {
  const src = read('src/templates/js/app.js');

  it('parses row.extra and renders it as key/value rows', () => {
    expect(src).toMatch(/JSON\.parse\(row\.extra\)/);
    expect(src).toMatch(/kvTable\(det\)/);
  });

  it('falls back to text (never breaks) on malformed extra', () => {
    expect(src).toMatch(/String\(det\)/);
  });

  it('engines_failed reason names the dead engines (not a bare code)', () => {
    const sources = read('src/shared/sources.ts');
    expect(sources).toMatch(/engines_failed: \$\{names\}/);
    const pipe = read('src/features/digest/pipeline.ts');
    expect(pipe).toMatch(/reason: report\.reason/);
    expect(pipe).toMatch(/engines:\s*gathered\.failures/);
    expect(pipe).toMatch(/hint:\s*report\.hint/);
  });
});
