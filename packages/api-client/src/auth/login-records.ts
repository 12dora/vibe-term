// 登录历史 REST。传入节点 ApiClient（`createNodeApiClient(nodeId)`）即打到该节点。

import type {
  LoginRecordSettings,
  LoginRecordsClearResult,
  LoginRecordsPage,
  LoginRecordsQuery,
} from '@vibeterm/shared';
import { type ApiClient, toApiError } from '../client';
import { requestJson } from '../json-mutation';

export const LOGIN_RECORDS_PATH = '/api/auth/login-records';
export const LOGIN_RECORD_SETTINGS_PATH = '/api/auth/login-records/settings';

function loginRecordsError(fallback: string) {
  return (res: Response) => toApiError(res, fallback);
}

export function loginRecordsPath(query: LoginRecordsQuery): string {
  const params = new URLSearchParams();
  params.set('outcome', query.outcome);
  if (query.kind) params.set('kind', query.kind);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.before) {
    params.set('before', String(query.before.at));
    params.set('beforeId', query.before.id);
  }
  return `${LOGIN_RECORDS_PATH}?${params.toString()}`;
}

export function listLoginRecords(
  client: ApiClient,
  query: LoginRecordsQuery,
  signal?: AbortSignal
): Promise<LoginRecordsPage> {
  return requestJson<LoginRecordsPage>(client, loginRecordsPath(query), {
    signal,
    toError: loginRecordsError('Failed to load login records'),
  });
}

export function clearLoginRecords(client: ApiClient): Promise<LoginRecordsClearResult> {
  return requestJson<LoginRecordsClearResult>(client, LOGIN_RECORDS_PATH, {
    method: 'DELETE',
    toError: loginRecordsError('Failed to clear login records'),
  });
}

export function getLoginRecordSettings(
  client: ApiClient,
  signal?: AbortSignal
): Promise<LoginRecordSettings> {
  return requestJson<LoginRecordSettings>(client, LOGIN_RECORD_SETTINGS_PATH, {
    signal,
    toError: loginRecordsError('Failed to load login record settings'),
  });
}

export function putLoginRecordSettings(
  client: ApiClient,
  settings: LoginRecordSettings
): Promise<LoginRecordSettings> {
  return requestJson<LoginRecordSettings>(client, LOGIN_RECORD_SETTINGS_PATH, {
    method: 'PUT',
    body: settings,
    toError: loginRecordsError('Failed to update login record settings'),
  });
}
