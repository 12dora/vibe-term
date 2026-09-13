// 微信 iLink 账号 REST（`/api/settings/weixin/*`）。

import type {
  ListWeixinAccountUsersResponse,
  ListWeixinAccountsResponse,
  StartWeixinLoginResponse,
  WeixinAccountUser,
  WeixinLoginStatusResponse,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export type WeixinAccountCreateRequest = {
  name: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

export type WeixinAccountUpdateRequest = {
  name?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

function accountPath(accountId: string, suffix = ''): string {
  return `/api/settings/weixin/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

export class WeixinApi {
  constructor(private readonly client: ApiClient = defaultApiClient) {}

  listAccounts(): Promise<ListWeixinAccountsResponse> {
    return requestJson<ListWeixinAccountsResponse>(this.client, '/api/settings/weixin/accounts', {
      errorFallback: 'Failed to list weixin accounts',
    });
  }

  createAccount(body: WeixinAccountCreateRequest): Promise<unknown> {
    return requestJson(this.client, '/api/settings/weixin/accounts', {
      method: 'POST',
      body,
      errorFallback: 'Failed to create weixin account',
    });
  }

  updateAccount(accountId: string, body: WeixinAccountUpdateRequest): Promise<unknown> {
    return requestJson(this.client, accountPath(accountId), {
      method: 'PATCH',
      body,
      errorFallback: 'Failed to update weixin account',
    });
  }

  async deleteAccount(accountId: string): Promise<void> {
    await requestOk(this.client, accountPath(accountId), {
      method: 'DELETE',
      errorFallback: 'Failed to delete weixin account',
    });
  }

  startLogin(accountId: string): Promise<StartWeixinLoginResponse> {
    return requestJson<StartWeixinLoginResponse>(
      this.client,
      accountPath(accountId, '/login/start'),
      {
        method: 'POST',
        errorFallback: 'Failed to start weixin login',
      }
    );
  }

  loginStatus(accountId: string): Promise<WeixinLoginStatusResponse> {
    return requestJson<WeixinLoginStatusResponse>(
      this.client,
      accountPath(accountId, '/login/status'),
      { errorFallback: 'Failed to load weixin login status' }
    );
  }

  testAccount(accountId: string): Promise<unknown> {
    return requestJson(this.client, accountPath(accountId, '/test'), {
      method: 'POST',
      errorFallback: 'Failed to test weixin account',
    });
  }

  listUsers(accountId: string): Promise<ListWeixinAccountUsersResponse> {
    return requestJson<ListWeixinAccountUsersResponse>(
      this.client,
      accountPath(accountId, '/users'),
      {
        errorFallback: 'Failed to list weixin users',
      }
    );
  }

  approveUser(accountId: string, userId: string): Promise<{ user: WeixinAccountUser }> {
    return requestJson(
      this.client,
      `${accountPath(accountId, '/users')}/${encodeURIComponent(userId)}/approve`,
      { method: 'POST', errorFallback: 'Failed to approve weixin user' }
    );
  }
}

export const defaultWeixinApi = new WeixinApi();
