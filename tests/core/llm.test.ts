import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletion } from '../../src/core/llm';
import type { LlmProfile } from '../../src/core/llm';

const profile = (over: Partial<LlmProfile> = {}): LlmProfile => ({
  baseUrl: 'https://llm.example/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  maxTokens: 128,
  timeoutMs: 5_000,
  ...over,
});

/** Install a mock fetch that returns one Response per sequential call. */
function mockSequential(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chatCompletion', () => {
  it('returns raw + finish_reason and sends the expected body', async () => {
    const calls = mockSequential([
      {
        status: 200,
        body: {
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        },
      },
    ]);
    const res = await chatCompletion(profile(), [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);

    expect(res).toEqual({ ok: true, raw: 'hello', finishReason: 'stop' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0); // default
    expect(body.max_tokens).toBe(128);
    expect(body.stream).toBe(false);
    expect(body.response_format).toBeUndefined(); // jsonMode off
    expect(calls[0].url).toBe('https://llm.example/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('retries once without response_format when the endpoint 400s in json mode', async () => {
    const calls = mockSequential([
      { status: 400, body: { error: 'response_format not supported' } },
      {
        status: 200,
        body: { choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] },
      },
    ]);
    const res = await chatCompletion(profile({ jsonMode: true }), [
      { role: 'user', content: 'hi' },
    ]);

    expect(res).toEqual({ ok: true, raw: '{"ok":1}', finishReason: 'stop' });
    expect(calls.length).toBe(2);
    const first = JSON.parse(calls[0].init.body as string);
    const second = JSON.parse(calls[1].init.body as string);
    expect(first.response_format).toEqual({ type: 'json_object' });
    expect(second.response_format).toBeUndefined();
  });

  it('normalizes HTTP errors to llm_error:<status>', async () => {
    mockSequential([{ status: 500, body: { error: 'boom' } }]);
    const res = await chatCompletion(profile(), [{ role: 'user', content: 'hi' }]);
    expect(res).toMatchObject({ ok: false, error: 'llm_error:500', detail: '{"error":"boom"}' });
  });

  it('normalizes empty content to llm_empty', async () => {
    mockSequential([{ status: 200, body: { choices: [{ message: { content: '' } }] } }]);
    const res = await chatCompletion(profile(), [{ role: 'user', content: 'hi' }]);
    expect(res).toEqual({ ok: false, error: 'llm_empty' });
  });

  it('maps an aborted request to llm_timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () =>
              rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );
    const res = await chatCompletion(profile({ timeoutMs: 20 }), [
      { role: 'user', content: 'hi' },
    ]);
    expect(res).toEqual({ ok: false, error: 'llm_timeout' });
  });

  it('merges a valid extraBody into the request and ignores invalid JSON', async () => {
    const calls = mockSequential([
      { status: 200, body: { choices: [{ message: { content: 'x' } }] } },
      { status: 200, body: { choices: [{ message: { content: 'x' } }] } },
    ]);
    await chatCompletion(profile({ extraBody: '{"seed":1}' }), [
      { role: 'user', content: 'hi' },
    ]);
    expect(JSON.parse(calls[0].init.body as string).seed).toBe(1);

    await chatCompletion(profile({ extraBody: '{not-json' }), [
      { role: 'user', content: 'hi' },
    ]);
    expect(JSON.parse(calls[1].init.body as string).seed).toBeUndefined();
  });
});
