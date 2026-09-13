import { describe, expect, it } from 'vitest';
import { isPolicyVideo } from '../../../src/features/moderation/policy';
import type { TelegramMessage } from '../../../src/core/types';

const msg = (over: Partial<TelegramMessage>): TelegramMessage =>
  ({ message_id: 1, date: 0, chat: { id: -100, type: 'supergroup' }, ...over }) as TelegramMessage;

describe('isPolicyVideo', () => {
  it('flags product-hosted videos in all three carriers', () => {
    expect(isPolicyVideo(msg({ video: { file_id: 'v' } }))).toBe(true);
    expect(isPolicyVideo(msg({ video_note: { file_id: 'v' } }))).toBe(true);
    expect(
      isPolicyVideo(msg({ document: { file_id: 'd', mime_type: 'video/mp4' } })),
    ).toBe(true);
  });

  it('spares everything that stays on the LLM image path', () => {
    expect(isPolicyVideo(msg({}))).toBe(false);
    expect(isPolicyVideo(msg({ photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }] }))).toBe(false);
    expect(isPolicyVideo(msg({ animation: { file_id: 'g' } }))).toBe(false); // GIFs are not affected
    expect(
      isPolicyVideo(msg({ document: { file_id: 'd', mime_type: 'image/png' } })),
    ).toBe(false);
  });
});
