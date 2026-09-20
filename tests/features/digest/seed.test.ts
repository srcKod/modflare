import { describe, expect, it } from 'vitest';
import { isSeedEnabled } from '../../../src/features/digest/config';

describe('isSeedEnabled (NEWS_DEV_SEED coercion)', () => {
  it('accepts the string "true" (quoted var)', () => {
    expect(isSeedEnabled('true')).toBe(true);
  });

  it('accepts the boolean true (unquoted var)', () => {
    expect(isSeedEnabled(true)).toBe(true);
  });

  it('is tolerant of case and surrounding whitespace', () => {
    expect(isSeedEnabled('  TRUE ')).toBe(true);
    expect(isSeedEnabled('True')).toBe(true);
  });

  it('treats anything else as disabled', () => {
    expect(isSeedEnabled(undefined)).toBe(false);
    expect(isSeedEnabled('')).toBe(false);
    expect(isSeedEnabled('false')).toBe(false);
    expect(isSeedEnabled(false)).toBe(false);
    expect(isSeedEnabled('1')).toBe(false);
  });
});
