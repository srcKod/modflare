import { describe, expect, it } from 'vitest';
import { makeLogger } from '../../src/core/logger';
import {
  adminRoutesOf,
  dispatchCron,
  dispatchUpdate,
  updateKind,
} from '../../src/core/router';
import type { Env, TelegramUpdate } from '../../src/core/types';
import type { FeatureManifest } from '../../src/core/router';

const env = {} as Env;
const logger = makeLogger(env);

function upd(kind: string): TelegramUpdate {
  switch (kind) {
    case 'message':
      return { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'supergroup' } } };
    case 'edited_message':
      return { update_id: 1, edited_message: { message_id: 1, chat: { id: 1, type: 'supergroup' } } };
    case 'message_reaction':
      return { update_id: 1, message_reaction: { chat: { id: 1 }, message_id: 1, date: 0 } } as unknown as TelegramUpdate;
    case 'message_reaction_count':
      return { update_id: 1, message_reaction_count: { chat: { id: 1 }, message_id: 1, date: 0 } } as unknown as TelegramUpdate;
    default:
      return { update_id: 1 };
  }
}

describe('updateKind', () => {
  it('derives the kind from the present field', () => {
    expect(updateKind(upd('message'))).toBe('message');
    expect(updateKind(upd('edited_message'))).toBe('edited_message');
    expect(updateKind(upd('message_reaction'))).toBe('message_reaction');
    expect(updateKind(upd('message_reaction_count'))).toBe('message_reaction_count');
    expect(updateKind({ update_id: 2 })).toBeNull();
  });
});

describe('dispatchUpdate', () => {
  it('runs the matching handler and reports handled', async () => {
    let ran = 0;
    const m: FeatureManifest = {
      name: 'a',
      updates: [
        {
          kinds: ['message'],
          priority: 50,
          handler: async () => {
            ran++;
            return true;
          },
        },
      ],
    };
    expect(await dispatchUpdate([m], env, upd('message'), logger)).toBe(true);
    expect(ran).toBe(1);
  });

  it('runs lower priority first and stops at the first true (short-circuit)', async () => {
    const order: string[] = [];
    const mk = (name: string, priority: number, handled: boolean): FeatureManifest => ({
      name,
      updates: [
        {
          kinds: ['message'],
          priority,
          handler: async () => {
            order.push(name);
            return handled;
          },
        },
      ],
    });
    const manifests = [mk('late', 100, true), mk('early', 10, true)];
    expect(await dispatchUpdate(manifests, env, upd('message'), logger)).toBe(true);
    expect(order).toEqual(['early']); // short-circuit: late handler never runs
  });

  it('continues through handlers that return false', async () => {
    const ran: string[] = [];
    const mk = (name: string, priority: number, handled: boolean): FeatureManifest => ({
      name,
      updates: [
        {
          kinds: ['message'],
          priority,
          handler: async () => {
            ran.push(name);
            return handled;
          },
        },
      ],
    });
    await dispatchUpdate([mk('a', 10, false), mk('b', 20, true)], env, upd('message'), logger);
    expect(ran).toEqual(['a', 'b']);
  });

  it('filters by update kind and returns false when nothing matches', async () => {
    let ran = 0;
    const m: FeatureManifest = {
      name: 'a',
      updates: [{ kinds: ['message'], priority: 10, handler: async () => { ran++; return true; } }],
    };
    expect(await dispatchUpdate([m], env, upd('edited_message'), logger)).toBe(false);
    expect(ran).toBe(0);
  });
});

describe('dispatchCron', () => {
  it('returns a handler for the matching expression', async () => {
    let ran = false;
    const m: FeatureManifest = {
      name: 'a',
      crons: [{ expr: '0 * * * *', handler: async () => { ran = true; } }],
    };
    const job = await dispatchCron([m], env, '0 * * * *');
    expect(job).not.toBeNull();
    await job?.();
    expect(ran).toBe(true);
  });
  it('returns null when no feature claims the expression', async () => {
    expect(await dispatchCron([], env, '9 9 9 9 9')).toBeNull();
  });
});

describe('adminRoutesOf', () => {
  it('flattens feature admin routes in registration order', () => {
    const m1: FeatureManifest = { name: 'a', adminRoutes: [{ method: 'GET', rest: '/x', handler: async () => new Response('') }] };
    const m2: FeatureManifest = { name: 'b', adminRoutes: [{ method: 'POST', rest: '/y', handler: async () => new Response('') }] };
    expect(adminRoutesOf([m1, m2]).map((r) => r.rest)).toEqual(['/x', '/y']);
  });
});
