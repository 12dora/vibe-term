// 文件 API 的 URL 构造（rootId 决定设备 + 白名单根，后端据此做本地/ssh-rsync 与路径校验）

export function filesApiUrl(
  endpoint: 'list' | 'content' | 'stat',
  rootId: string,
  path?: string
): string {
  const params = new URLSearchParams({ rootId });
  if (path != null) params.set('path', path);
  return `/api/files/${endpoint}?${params.toString()}`;
}

export function fileRawUrl(rootId: string, path: string, download = false): string {
  const params = new URLSearchParams({ rootId, path });
  if (download) params.set('download', '1');
  return `/api/files/raw?${params.toString()}`;
}

// 流式下载端点（rsync 拉取 → 磁盘流式返回，支持大文件）。用于菜单下载与拖到桌面。
export function fileDownloadUrl(rootId: string, path: string): string {
  const params = new URLSearchParams({ rootId, path });
  return `/api/files/download?${params.toString()}`;
}
