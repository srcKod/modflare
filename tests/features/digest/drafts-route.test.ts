import { describe, expect, it } from 'vitest';
import { parseDraftsPath } from '../../../src/features/digest/config';

describe('parseDraftsPath (route intent parsing)', () => {
  it('matches the drafts list path', () => {
    expect(parseDraftsPath('/api/digest/drafts')).toEqual({ kind: 'list' });
  });

  it('matches a numeric single-draft id (the bug: \\\\d must match digits)', () => {
    expect(parseDraftsPath('/api/digest/drafts/5')).toEqual({ kind: 'one', id: 5 });
    expect(parseDraftsPath('/api/digest/drafts/123')).toEqual({ kind: 'one', id: 123 });
  });

  it('matches a numeric action path', () => {
    expect(parseDraftsPath('/api/digest/drafts/5/save')).toEqual({
      kind: 'action',
      id: 5,
      action: 'save',
    });
    expect(parseDraftsPath('/api/digest/drafts/42/publish')).toEqual({
      kind: 'action',
      id: 42,
      action: 'publish',
    });
    expect(parseDraftsPath('/api/digest/drafts/7/discard')).toEqual({
      kind: 'action',
      id: 7,
      action: 'discard',
    });
    expect(parseDraftsPath('/api/digest/drafts/9/retry')).toEqual({
      kind: 'action',
      id: 9,
      action: 'retry',
    });
  });

  it('rejects non-numeric ids and unknown suffixes as unknown', () => {
    expect(parseDraftsPath('/api/digest/drafts/abc')).toEqual({
      kind: 'unknown',
      rest: '/api/digest/drafts/abc',
    });
    expect(parseDraftsPath('/api/digest/drafts/5/unknown')).toEqual({
      kind: 'unknown',
      rest: '/api/digest/drafts/5/unknown',
    });
    expect(parseDraftsPath('/api/digest/other')).toEqual({
      kind: 'unknown',
      rest: '/api/digest/other',
    });
  });
});
