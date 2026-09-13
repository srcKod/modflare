import { describe, expect, it } from 'vitest';
import { envBool, envInt, envList } from '../../src/core/config';

describe('envList', () => {
  it('returns [] for undefined/empty', () => {
    expect(envList(undefined)).toEqual([]);
    expect(envList('')).toEqual([]);
    expect(envList('  ')).toEqual([]);
  });
  it('splits commas and whitespace, trims, drops empties', () => {
    expect(envList('a,b')).toEqual(['a', 'b']);
    expect(envList(' a , b ')).toEqual(['a', 'b']);
    expect(envList('a,,b')).toEqual(['a', 'b']);
    expect(envList('a b')).toEqual(['a', 'b']);
  });
  it('keeps values that look like negatives or symbols', () => {
    expect(envList('-100123')).toEqual(['-100123']);
    expect(envList('@carol')).toEqual(['@carol']);
  });
});

describe('envBool', () => {
  it('accepts true/1/yes case-insensitively', () => {
    expect(envBool('true', false)).toBe(true);
    expect(envBool('TRUE', false)).toBe(true);
    expect(envBool('1', false)).toBe(true);
    expect(envBool('yes', false)).toBe(true);
  });
  it('falls back to the default for unset or unrecognized values', () => {
    expect(envBool(undefined, true)).toBe(true);
    expect(envBool(undefined, false)).toBe(false);
    expect(envBool('false', true)).toBe(false);
    expect(envBool('bogus', true)).toBe(false);
    expect(envBool('', false)).toBe(false);
  });
});

describe('envInt', () => {
  it('parses integers and falls back on garbage', () => {
    expect(envInt('42', 0)).toBe(42);
    expect(envInt('  5 ', 0)).toBe(5);
    expect(envInt('-3', 0)).toBe(-3);
    expect(envInt(undefined, 7)).toBe(7);
    expect(envInt('abc', 7)).toBe(7);
    expect(envInt('', 7)).toBe(7);
  });
});
