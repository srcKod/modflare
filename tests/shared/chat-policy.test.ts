import { describe, expect, it } from 'vitest';
import {
  chatAllowed,
  isAllowedGroup,
  isGroupChat,
} from '../../src/shared/chat-policy';
import type { Env } from '../../src/core/types';

// Shared front gate for every message-consuming feature (extracted from the
// moderation pipeline — behavior locked here so features can't drift apart).

const envWith = (ids?: string) => ({ ALLOWED_GROUP_IDS: ids }) as unknown as Env;

describe('isGroupChat', () => {
  it('passes groups and supergroups only', () => {
    expect(isGroupChat('group')).toBe(true);
    expect(isGroupChat('supergroup')).toBe(true);
    expect(isGroupChat('private')).toBe(false);
    expect(isGroupChat('channel')).toBe(false);
    expect(isGroupChat(undefined)).toBe(false);
    expect(isGroupChat('')).toBe(false);
  });
});

describe('isAllowedGroup', () => {
  it('allows all when unset or empty (backward compatible)', () => {
    expect(isAllowedGroup(envWith(undefined), -1001)).toBe(true);
    expect(isAllowedGroup(envWith(''), -1001)).toBe(true);
    expect(isAllowedGroup(envWith('   '), -1001)).toBe(true);
  });

  it('allows listed chats, blocks the rest, ignores garbage', () => {
    const env = envWith('-1001, 42, junk, -1002.5x');
    expect(isAllowedGroup(env, -1001)).toBe(true);
    expect(isAllowedGroup(env, 42)).toBe(true);
    expect(isAllowedGroup(env, -999)).toBe(false);
  });
});

describe('chatAllowed', () => {
  it('checks group-type before the whitelist', () => {
    expect(chatAllowed(envWith('-1001'), 'private', -1001)).toEqual({
      allowed: false,
      reason: 'non_group',
    });
    expect(chatAllowed(envWith('-1001'), 'group', -999)).toEqual({
      allowed: false,
      reason: 'group_not_whitelisted',
    });
    expect(chatAllowed(envWith('-1001'), 'supergroup', -1001)).toEqual({
      allowed: true,
      reason: null,
    });
  });
});
