import { describe, expect, test } from 'bun:test';
import { ApiClient } from './client';
import { TelegramApi } from './telegram';

type Call = { url: string; init?: RequestInit };

function recorder(responses: Response[]): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const client = new ApiClient('', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(responses[index++] ?? new Response('{}', { status: 200 }));
  });
  return { api: new TelegramApi(client), calls };
}

describe('TelegramApi', () => {
  test('lists bots', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ bots: [{ id: 'b1' }] }), { status: 200 }),
    ]);
    expect(await api.listBots()).toEqual({ bots: [{ id: 'b1' }] } as never);
    expect(calls[0].url).toBe('/api/settings/telegram/bots');
  });

  test('creates, patches, deletes a bot', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ success: true }), { status: 201 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ]);
    await api.createBot({ name: 'ops', token: 't' });
    await api.updateBot('b1', { enabled: false });
    await api.deleteBot('b1');
    expect(calls[0]).toMatchObject({ url: '/api/settings/telegram/bots' });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ name: 'ops', token: 't' });
    expect(calls[1].url).toBe('/api/settings/telegram/bots/b1');
    expect(calls[1].init?.method).toBe('PATCH');
    expect(calls[2].init?.method).toBe('DELETE');
  });

  test('encodes chat ids on approve/test/delete', async () => {
    const { api, calls } = recorder([
      new Response(JSON.stringify({ chats: [] }), { status: 200 }),
      new Response(JSON.stringify({ chat: { chatId: '-700' } }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ]);
    await api.listChats('b1');
    await api.approveChat('b1', '-700');
    await api.testChat('b1', 'chat:2');
    await api.deleteChat('b1', 'chat:2');
    expect(calls[0].url).toBe('/api/settings/telegram/bots/b1/chats');
    expect(calls[1].url).toBe('/api/settings/telegram/bots/b1/chats/-700/approve');
    expect(calls[2].url).toBe('/api/settings/telegram/bots/b1/chats/chat%3A2/test');
    expect(calls[3].url).toBe('/api/settings/telegram/bots/b1/chats/chat%3A2');
  });
});
