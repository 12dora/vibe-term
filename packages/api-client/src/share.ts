// 终端分享（分享方）REST 端点：挂在终端所在节点，经 Hub 时由 ApiClient 的 `/n/<nodeId>` baseUrl 前缀承担。
//
// 设置 / 日志 / 删除历史三族端点由设置页自带客户端消费，不在此文件。

import type { ShareOriginCandidate, ShareRecord } from '@tmex/shared/share';
import type { ApiClient } from './client';
import { requestJson } from './json-mutation';

export interface ShareListFilter {
  deviceId?: string;
  windowId?: string;
}

export interface ShareListResponse {
  active: ShareRecord[];
  history: ShareRecord[];
}

export interface CreateShareInput {
  deviceId: string;
  windowId: string;
  name: string;
  password: string;
  /** null = 永久 */
  expiresInMs: number | null;
  origin: string;
}

/** 密码是明文，服务端只在创建时返回这一次。 */
export interface CreateShareResponse {
  share: ShareRecord;
  password: string;
}

export interface ShareOriginsResponse {
  candidates: ShareOriginCandidate[];
  recommended: string | null;
  nodePrefix: string | null;
}

/** 查询缓存键：按 (deviceId, windowId) 分片，缺省即全量列表。 */
export function shareQueryKey(filter: ShareListFilter = {}): readonly unknown[] {
  return ['share', filter.deviceId ?? null, filter.windowId ?? null] as const;
}

export function shareListPath(filter: ShareListFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.deviceId) params.set('deviceId', filter.deviceId);
  if (filter.windowId) params.set('windowId', filter.windowId);
  const query = params.toString();
  return query ? `/api/share?${query}` : '/api/share';
}

export function listShares(
  client: ApiClient,
  filter: ShareListFilter = {},
  signal?: AbortSignal
): Promise<ShareListResponse> {
  return requestJson<ShareListResponse>(client, shareListPath(filter), {
    signal,
    errorFallback: 'Failed to load shares',
  });
}

export function createShare(
  client: ApiClient,
  input: CreateShareInput
): Promise<CreateShareResponse> {
  return requestJson<CreateShareResponse>(client, '/api/share', {
    method: 'POST',
    body: input,
    errorFallback: 'Failed to create share',
  });
}

export function revokeShare(client: ApiClient, id: string): Promise<ShareRecord> {
  return requestJson<{ share: ShareRecord }, ShareRecord>(
    client,
    `/api/share/${encodeURIComponent(id)}/revoke`,
    {
      method: 'POST',
      errorFallback: 'Failed to stop share',
      pick: (payload) => payload.share,
    }
  );
}

export function getShareOrigins(client: ApiClient): Promise<ShareOriginsResponse> {
  return requestJson<ShareOriginsResponse>(client, '/api/share/origins', {
    errorFallback: 'Failed to load share addresses',
  });
}
