import { describe, expect, test } from 'bun:test';
import type { TelegramBotChat } from '@vibeterm/shared';
import { boundUserLabel } from './telegram-bot-chats-modal';

const chat: TelegramBotChat = {
  id: 'c1',
  botId: 'b1',
  chatId: '-1001',
  chatType: 'supergroup',
  displayName: 'ops group',
  userId: '42',
  boundUserId: '42',
  boundUserName: null,
  status: 'pending',
  appliedAt: '2026-01-01T00:00:00.000Z',
  authorizedAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('boundUserLabel', () => {
  test('有名字写「名字 (id)」，没有名字只写 id', () => {
    expect(boundUserLabel({ ...chat, boundUserId: '42', boundUserName: 'alice' })).toBe(
      'alice (42)'
    );
    expect(boundUserLabel({ ...chat, boundUserId: '42', boundUserName: null })).toBe('42');
    expect(boundUserLabel({ ...chat, boundUserId: '42', boundUserName: '  ' })).toBe('42');
  });

  test('未绑定指令人：不显示这一行', () => {
    expect(boundUserLabel({ ...chat, userId: null, boundUserId: '' })).toBeNull();
  });
});
