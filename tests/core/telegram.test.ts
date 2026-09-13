import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUserMention,
  deleteMessageDetailed,
  htmlEscape,
} from '../../src/core/telegram';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('htmlEscape', () => {
  it('escapes & < >', () => {
    expect(htmlEscape('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});

describe('buildUserMention', () => {
  it('prefers the @username', () => {
    expect(buildUserMention({ id: 1, first_name: 'Al', username: 'bob' })).toBe('@bob');
  });
  it('falls back to a name link for users without a username', () => {
    expect(buildUserMention({ id: 42, first_name: 'Al' })).toBe(
      '<a href="tg://user?id=42">Al</a>',
    );
  });
  it('returns the bare name without an id, and null without any info', () => {
    expect(buildUserMention({ first_name: 'Al' })).toBe('Al');
    expect(buildUserMention(undefined)).toBeNull();
    expect(buildUserMention({ id: 1 })).toBeNull();
  });
});

describe('deleteMessageDetailed', () => {
  it('treats "message to delete not found" as already-gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, description: 'Bad Request: message to delete not found' }),
          { status: 400 },
        ),
      ),
    );
    const env = { BOT_TOKEN: 't' } as never;
    const res = await deleteMessageDetailed(env, 1, 2);
    expect(res.ok).toBe(false);
    expect(res.notFound).toBe(true);
  });
  it('reports plain success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const env = { BOT_TOKEN: 't' } as never;
    const res = await deleteMessageDetailed(env, 1, 2);
    expect(res.ok).toBe(true);
    expect(res.notFound).toBe(false);
  });
});
