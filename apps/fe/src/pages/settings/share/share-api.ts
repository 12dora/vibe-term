// 设置页「分享」标签的 REST 客户端。
//
// 列表 / 终止 / 地址候选三族端点由 `@tmex/api-client/share` 提供（终端工具栏的分享弹窗也用同一份），
// 这里只补上设置页独有的三族：设置读写、历史删除、日志分页。查询键一并放在这里，
// 悬停预取与面板挂载共用同一份，避免同一个键里写进形状不同的数据。

import type { ApiClient } from '@tmex/api-client';
import { requestJson, requestOk } from '@tmex/api-client/json-mutation';
import type { ShareLogPage, ShareSettings } from '@tmex/shared/share';

export {
  getShareOrigins,
  listShares,
  revokeShare,
  shareListPath,
  shareQueryKey,
} from '@tmex/api-client/share';
export type {
  ShareListResponse,
  ShareOriginsResponse,
} from '@tmex/api-client/share';

export const SHARE_SETTINGS_PATH = '/api/share/settings';
export const SHARE_ORIGINS_PATH = '/api/share/origins';

export const shareSettingsQueryKey = ['share-settings'] as const;
export const shareOriginsQueryKey = ['share-origins'] as const;

export function shareLogQueryKey(shareId: string): readonly unknown[] {
  return ['share-log', shareId] as const;
}

export function shareResourcePath(shareId: string): string {
  return `/api/share/${encodeURIComponent(shareId)}`;
}

export interface ShareLogQuery {
  /** 只取 seq 大于该值的条目；缺省从头开始。 */
  after?: number;
  limit?: number;
}

export function shareLogPath(shareId: string, query: ShareLogQuery = {}): string {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set('after', String(query.after));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return search
    ? `${shareResourcePath(shareId)}/log?${search}`
    : `${shareResourcePath(shareId)}/log`;
}

export function fetchShareSettings(
  client: ApiClient,
  signal?: AbortSignal
): Promise<ShareSettings> {
  return requestJson<ShareSettings>(client, SHARE_SETTINGS_PATH, {
    signal,
    errorFallback: 'Failed to load share settings',
  });
}

export function saveShareSettings(
  client: ApiClient,
  patch: Partial<ShareSettings>
): Promise<ShareSettings> {
  return requestJson<ShareSettings>(client, SHARE_SETTINGS_PATH, {
    method: 'PUT',
    body: patch,
    errorFallback: 'Failed to save share settings',
  });
}

/** 删除一条已结束的分享；日志一并删除。 */
export async function deleteShare(client: ApiClient, shareId: string): Promise<void> {
  await requestOk(client, shareResourcePath(shareId), {
    method: 'DELETE',
    errorFallback: 'Failed to delete share',
  });
}

export function fetchShareLogPage(
  client: ApiClient,
  shareId: string,
  query: ShareLogQuery = {},
  signal?: AbortSignal
): Promise<ShareLogPage> {
  return requestJson<ShareLogPage>(client, shareLogPath(shareId, query), {
    signal,
    errorFallback: 'Failed to load share log',
  });
}
