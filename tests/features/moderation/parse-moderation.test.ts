import { describe, expect, it } from 'vitest';
import { parseModeration } from '../../../src/features/moderation/llm';

describe('parseModeration', () => {
  it('parses a strict JSON verdict', () => {
    expect(parseModeration('{"flag":true,"reason":"spam"}')).toEqual({
      flag: true,
      reason: 'spam',
      llmResponse: '{"flag":true,"reason":"spam"}',
    });
  });

  it('accepts string/number truthy flag values', () => {
    expect(parseModeration('{"flag":"true","reason":"r"}').flag).toBe(true);
    expect(parseModeration('{"flag":"yes","reason":"r"}').flag).toBe(true);
    expect(parseModeration('{"flag":1,"reason":"r"}').flag).toBe(true);
    expect(parseModeration('{"flag":false,"reason":"r"}').flag).toBe(false);
  });

  it('extracts a JSON object embedded in prose', () => {
    const res = parseModeration('Sure! {"flag":true,"reason":"phishing"} hope this helps');
    expect(res.flag).toBe(true);
    expect(res.reason).toBe('phishing');
  });

  it('falls back to a plain "flag: true" line', () => {
    expect(parseModeration('flag: true').flag).toBe(true);
    expect(parseModeration('yes').flag).toBe(true);
    expect(parseModeration('flag=true').flag).toBe(true);
  });

  it('fails open: empty, unparseable, or garbage output never flags', () => {
    for (const raw of ['', '   ', 'I cannot answer that', '{"flag":tru}']) {
      const res = parseModeration(raw);
      expect(res.flag).toBe(false);
      expect(res.reason).toBe('unparseable');
    }
  });

  it('preserves the raw LLM text for the audit log', () => {
    const res = parseModeration('garbage output', 'RAW MODEL TEXT');
    expect(res.llmResponse).toBe('RAW MODEL TEXT');
  });

  it('extracts the optional fun_response only when present and non-empty', () => {
    const withFun = parseModeration('{"flag":true,"reason":"r","fun_response":"haha nice"}');
    expect(withFun.funResponse).toBe('haha nice');
    const emptyFun = parseModeration('{"flag":true,"reason":"r","fun_response":""}');
    expect(emptyFun.funResponse).toBeUndefined();
  });
});
