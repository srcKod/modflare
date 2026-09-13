import { describe, expect, it } from 'vitest';
import { hourInTz, isHourInRange } from '../../src/core/time';

const NOON_UTC = new Date('2026-09-13T12:00:00Z');

describe('hourInTz', () => {
  it('resolves the hour in the requested timezone', () => {
    expect(hourInTz('UTC', NOON_UTC)).toBe(12);
    expect(hourInTz('Asia/Baghdad', NOON_UTC)).toBe(15); // UTC+3
  });
  it('falls back to UTC on an invalid timezone', () => {
    expect(hourInTz('Not/AZone', NOON_UTC)).toBe(12);
  });
});

describe('isHourInRange', () => {
  it('handles a normal window [start, end)', () => {
    expect(isHourInRange(9, 9, 18)).toBe(true); // start inclusive
    expect(isHourInRange(17, 9, 18)).toBe(true);
    expect(isHourInRange(18, 9, 18)).toBe(false); // end exclusive
    expect(isHourInRange(3, 9, 18)).toBe(false);
  });
  it('handles cross-midnight windows (start=22, end=6)', () => {
    expect(isHourInRange(22, 22, 6)).toBe(true);
    expect(isHourInRange(23, 22, 6)).toBe(true);
    expect(isHourInRange(5, 22, 6)).toBe(true);
    expect(isHourInRange(6, 22, 6)).toBe(false);
    expect(isHourInRange(12, 22, 6)).toBe(false);
  });
  it('treats start === end as a 24-hour window', () => {
    expect(isHourInRange(0, 0, 0)).toBe(true);
    expect(isHourInRange(13, 0, 0)).toBe(true);
    expect(isHourInRange(23, 5, 5)).toBe(true);
  });
});
