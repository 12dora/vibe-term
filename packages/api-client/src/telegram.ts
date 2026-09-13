// Telegram bots + chats REST（`/api/settings/telegram/*`）。

import type {
  ListTelegramBotChatsResponse,
  ListTelegramBotsResponse,
  TelegramBotChat,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export type TelegramBotCreateRequest = {
  name: string;
  token: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

export type TelegramBotUpdateRequest = {
  name?: string;
  token?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

function botPath(botId: string, suffix = ''): string {
  return `/api/settings/telegram/bots/${encodeURIComponent(botId)}${suffix}`;
}

function chatPath(botId: string, chatId: string, suffix = ''): string {
  return `${botPath(botId, '/chats')}/${encodeURIComponent(chatId)}${suffix}`;
}

export class TelegramApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  listBots(): Promise<ListTelegramBotsResponse> {
    return requestJson<ListTelegramBotsResponse>(this.client, '/api/settings/telegram/bots', {
      errorFallback: 'Failed to list telegram bots',
    });
  }

  createBot(body: TelegramBotCreateRequest): Promise<unknown> {
    return requestJson(this.client, '/api/settings/telegram/bots', {
      method: 'POST',
      body,
      errorFallback: 'Failed to create telegram bot',
    });
  }

  updateBot(botId: string, body: TelegramBotUpdateRequest): Promise<unknown> {
    return requestJson(this.client, botPath(botId), {
      method: 'PATCH',
      body,
      errorFallback: 'Failed to update telegram bot',
    });
  }

  async deleteBot(botId: string): Promise<void> {
    await requestOk(this.client, botPath(botId), {
      method: 'DELETE',
      errorFallback: 'Failed to delete telegram bot',
    });
  }

  listChats(botId: string): Promise<ListTelegramBotChatsResponse> {
    return requestJson<ListTelegramBotChatsResponse>(this.client, botPath(botId, '/chats'), {
      errorFallback: 'Failed to list telegram chats',
    });
  }

  approveChat(botId: string, chatId: string): Promise<{ chat: TelegramBotChat }> {
    return requestJson(this.client, chatPath(botId, chatId, '/approve'), {
      method: 'POST',
      errorFallback: 'Failed to approve telegram chat',
    });
  }

  testChat(botId: string, chatId: string): Promise<unknown> {
    return requestJson(this.client, chatPath(botId, chatId, '/test'), {
      method: 'POST',
      errorFallback: 'Failed to test telegram chat',
    });
  }

  async deleteChat(botId: string, chatId: string): Promise<void> {
    await requestOk(this.client, chatPath(botId, chatId), {
      method: 'DELETE',
      errorFallback: 'Failed to delete telegram chat',
    });
  }
}

export const defaultTelegramApi = new TelegramApi();
