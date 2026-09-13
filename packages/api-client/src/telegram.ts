// Telegram bots + chats REST（`/api/settings/telegram/*`）。

import type {
  ListTelegramBotChatsResponse,
  ListTelegramBotsResponse,
  TelegramBotChat,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';
import {
  type MessagingChannelClient,
  type MessagingChannelFlags,
  createMessagingChannelClient,
} from './messaging-channel';

export type TelegramBotCreateRequest = {
  name: string;
  token: string;
} & MessagingChannelFlags;

export type TelegramBotUpdateRequest = {
  name?: string;
  token?: string;
} & MessagingChannelFlags;

const TELEGRAM_CHANNEL = {
  basePath: '/api/settings/telegram/bots',
  parentLabel: 'telegram bot',
  childCollection: 'chats',
  childLabel: 'telegram chat',
} as const;

export class TelegramApi {
  private readonly channel: MessagingChannelClient;

  constructor(private readonly client: ApiClient = defaultApiClient) {
    this.channel = createMessagingChannelClient(TELEGRAM_CHANNEL, client);
  }

  listBots(): Promise<ListTelegramBotsResponse> {
    return this.channel.list();
  }

  createBot(body: TelegramBotCreateRequest): Promise<unknown> {
    return this.channel.create(body);
  }

  updateBot(botId: string, body: TelegramBotUpdateRequest): Promise<unknown> {
    return this.channel.update(botId, body);
  }

  deleteBot(botId: string): Promise<void> {
    return this.channel.remove(botId);
  }

  listChats(botId: string): Promise<ListTelegramBotChatsResponse> {
    return this.channel.listChildren(botId);
  }

  approveChat(botId: string, chatId: string): Promise<{ chat: TelegramBotChat }> {
    return this.channel.approveChild(botId, chatId);
  }

  testChat(botId: string, chatId: string): Promise<unknown> {
    return requestJson(this.client, this.channel.childPath(botId, chatId, '/test'), {
      method: 'POST',
      errorFallback: 'Failed to test telegram chat',
    });
  }

  async deleteChat(botId: string, chatId: string): Promise<void> {
    await requestOk(this.client, this.channel.childPath(botId, chatId), {
      method: 'DELETE',
      errorFallback: 'Failed to delete telegram chat',
    });
  }
}

export const defaultTelegramApi = new TelegramApi();
