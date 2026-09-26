import { getLoginPolicy as getRemoteLoginPolicy } from '@vibeterm/api-client/auth/login-policy';
import {
  clearLoginRecords as clearRemoteRecords,
  getLoginRecordSettings,
  listLoginRecords as listRemoteRecords,
  putLoginRecordSettings,
} from '@vibeterm/api-client/auth/login-records';
import { ApiClient, ApiError } from '@vibeterm/api-client/client';
import {
  type LoginRecord,
  type LoginRecordRetentionDays,
  type LoginRecordsQuery,
  isLoginRecordRetentionDays,
} from '@vibeterm/shared';
import { CliError } from './errors';
import type { HttpClient } from './http';
import { httpStatusError } from './http';

function nodeApiClient(http: HttpClient, nodeId: string): ApiClient {
  return new ApiClient('', async (url, init) => {
    const { signal, ...rest } = init ?? {};
    return http.fetch(nodeId, url, {
      ...rest,
      ...(signal ? { signal } : {}),
    });
  });
}

async function callNode<T>(nodeId: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      throw httpStatusError(nodeId, path, error.status, error.message);
    }
    throw error;
  }
}

export async function listLoginRecords(
  http: HttpClient,
  nodeId: string,
  query: LoginRecordsQuery
): Promise<LoginRecord[]> {
  const page = await callNode(nodeId, '/api/auth/login-records', () =>
    listRemoteRecords(nodeApiClient(http, nodeId), query)
  );
  if (!page || !Array.isArray(page.records)) {
    throw new CliError('login records response is malformed');
  }
  return page.records;
}

export async function clearLoginRecords(http: HttpClient, nodeId: string): Promise<number> {
  const payload = await callNode(nodeId, '/api/auth/login-records', () =>
    clearRemoteRecords(nodeApiClient(http, nodeId))
  );
  return typeof payload.deleted === 'number' ? payload.deleted : 0;
}

export async function getLoginRetention(http: HttpClient, nodeId: string): Promise<number> {
  const payload = await callNode(nodeId, '/api/auth/login-records/settings', () =>
    getLoginRecordSettings(nodeApiClient(http, nodeId))
  );
  if (!isLoginRecordRetentionDays(payload.retentionDays)) {
    throw new CliError('login record settings are malformed');
  }
  return payload.retentionDays;
}

export async function putLoginRetention(
  http: HttpClient,
  nodeId: string,
  retentionDays: LoginRecordRetentionDays
): Promise<number> {
  const payload = await callNode(nodeId, '/api/auth/login-records/settings', () =>
    putLoginRecordSettings(nodeApiClient(http, nodeId), { retentionDays })
  );
  if (!isLoginRecordRetentionDays(payload.retentionDays)) {
    throw new CliError('login record settings are malformed');
  }
  return payload.retentionDays;
}

export async function getLoginPolicy(http: HttpClient, nodeId: string): Promise<unknown> {
  return callNode(nodeId, '/api/auth/login-policy', () =>
    getRemoteLoginPolicy(nodeApiClient(http, nodeId))
  );
}
