import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import {
  createOrUpdatePendingTelegramChat,
  createTelegramBot,
  getTelegramChatByBotAndChatId,
} from '../db';
import { getDb as getOrmDb } from '../db/client';
import { telegramService } from '../telegram/service';
import { dispatchRoutes } from './route';
import { telegramRoutes } from './telegram-routes';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

async function call(
  method: string,
  path: string
): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const req = new Request(`http://localhost${path}`, { method });
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, telegramRoutes, {
    server: {} as never,
    path: pathname,
  });
  if (!response) throw new Error(`no route matched: ${method} ${path}`);
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Record<string, unknown> };
}

describe('telegram approve route', () => {
  test('keeps the pending row user_id', async () => {
    const botId = crypto.randomUUID();
    const now = new Date().toISOString();
    createTelegramBot({
      id: botId,
      name: 'approve',
      tokenEnc: 'enc',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: false,
      lastUpdateId: null,
      createdAt: now,
      updatedAt: now,
    });
    createOrUpdatePendingTelegramChat({
      botId,
      chatId: '-700',
      chatType: 'group',
      displayName: 'ops',
      appliedAt: now,
      userId: '42',
    });
    const send = spyOn(telegramService, 'sendTestMessage').mockResolvedValue(undefined);
    try {
      const res = await call(
        'POST',
        `/api/settings/telegram/bots/${botId}/chats/${encodeURIComponent('-700')}/approve`
      );
      expect(res.status).toBe(200);
      const chat = getTelegramChatByBotAndChatId(botId, '-700');
      expect(chat?.status).toBe('authorized');
      expect(chat?.userId).toBe('42');
    } finally {
      send.mockRestore();
    }
  });
});
