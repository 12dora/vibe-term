// 微信 iLink 账号 REST（`/api/settings/weixin/*`）。

import type {
  ListWeixinAccountUsersResponse,
  ListWeixinAccountsResponse,
  StartWeixinLoginResponse,
  WeixinAccountUser,
  WeixinLoginStatusResponse,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';
import {
  type MessagingChannelClient,
  type MessagingChannelFlags,
  createMessagingChannelClient,
} from './messaging-channel';

export type WeixinAccountCreateRequest = {
  name: string;
} & MessagingChannelFlags;

export type WeixinAccountUpdateRequest = {
  name?: string;
} & MessagingChannelFlags;

const WEIXIN_CHANNEL = {
  basePath: '/api/settings/weixin/accounts',
  parentLabel: 'weixin account',
  childCollection: 'users',
  childLabel: 'weixin user',
} as const;

export class WeixinApi {
  private readonly channel: MessagingChannelClient;

  constructor(private readonly client: ApiClient = defaultApiClient) {
    this.channel = createMessagingChannelClient(WEIXIN_CHANNEL, client);
  }

  listAccounts(): Promise<ListWeixinAccountsResponse> {
    return this.channel.list();
  }

  createAccount(body: WeixinAccountCreateRequest): Promise<unknown> {
    return this.channel.create(body);
  }

  updateAccount(accountId: string, body: WeixinAccountUpdateRequest): Promise<unknown> {
    return this.channel.update(accountId, body);
  }

  deleteAccount(accountId: string): Promise<void> {
    return this.channel.remove(accountId);
  }

  startLogin(accountId: string): Promise<StartWeixinLoginResponse> {
    return requestJson<StartWeixinLoginResponse>(
      this.client,
      this.channel.parentPath(accountId, '/login/start'),
      {
        method: 'POST',
        errorFallback: 'Failed to start weixin login',
      }
    );
  }

  loginStatus(accountId: string): Promise<WeixinLoginStatusResponse> {
    return requestJson<WeixinLoginStatusResponse>(
      this.client,
      this.channel.parentPath(accountId, '/login/status'),
      { errorFallback: 'Failed to load weixin login status' }
    );
  }

  testAccount(accountId: string): Promise<unknown> {
    return requestJson(this.client, this.channel.parentPath(accountId, '/test'), {
      method: 'POST',
      errorFallback: 'Failed to test weixin account',
    });
  }

  listUsers(accountId: string): Promise<ListWeixinAccountUsersResponse> {
    return this.channel.listChildren(accountId);
  }

  approveUser(accountId: string, userId: string): Promise<{ user: WeixinAccountUser }> {
    return this.channel.approveChild(accountId, userId);
  }
}

export const defaultWeixinApi = new WeixinApi();
