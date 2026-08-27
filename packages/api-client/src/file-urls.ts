// 文件 API 的 URL 构造（rootId 决定设备 + 白名单根，后端据此做本地/ssh-rsync 与路径校验）

import { resolveNodeUrl } from './node-url';

export function filesApiUrl(
  endpoint: 'list' | 'content' | 'stat',
  rootId: string,
  path?: string
): string {
  const params = new URLSearchParams({ rootId });
  if (path != null) params.set('path', path);
  return `/api/files/${endpoint}?${params.toString()}`;
}

// raw / download 是唯二直接进入 DOM（<img src>、<a href>、拖拽下载）的文件 URL，
// 不经 ApiClient，因此必须显式带上 nodeId（self 时结果与旧行为逐字节一致）。
export function fileRawUrl(nodeId: string, rootId: string, path: string, download = false): string {
  const params = new URLSearchParams({ rootId, path });
  if (download) params.set('download', '1');
  return resolveNodeUrl(nodeId, `/api/files/raw?${params.toString()}`);
}

// 流式下载端点（rsync 拉取 → 磁盘流式返回，支持大文件）。用于菜单下载与拖到桌面。
export function fileDownloadUrl(nodeId: string, rootId: string, path: string): string {
  const params = new URLSearchParams({ rootId, path });
  return resolveNodeUrl(nodeId, `/api/files/download?${params.toString()}`);
}
