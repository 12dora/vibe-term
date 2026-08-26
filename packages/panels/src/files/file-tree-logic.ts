// 文件树的纯逻辑：路径换算、展开态修正、上传前的体积分流、rsync 缺失的安装目标解析。

import type { FileErrorCode, FileRootDto } from '@tmex/shared';

export function parentOf(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

export function nodeBasename(p: string): string {
  const i = p.lastIndexOf('/');
  const b = i >= 0 ? p.slice(i + 1) : p;
  return b || p;
}

// 相对于树根的路径：剥离 root 前缀；root 自身返回 '.'。
export function relativeToRoot(rootPath: string, path: string): string {
  if (path === rootPath) return '.';
  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function fileErrorKey(code?: FileErrorCode): string {
  return `files.error.${code ?? 'unknown'}`;
}

// 外部 OS 文件拖入判定：Firefox 的 dataTransfer.types 是 DOMStringList（无 includes），故 Array.from。
export function dataTransferHasFiles(types: Iterable<string> | ArrayLike<string>): boolean {
  return Array.from(types).includes('Files');
}

export type RsyncMissingSide = 'local' | 'remote';

export function rsyncMissingSide(code?: FileErrorCode): RsyncMissingSide | null {
  if (code === 'rsync_missing_remote') return 'remote';
  if (code === 'rsync_missing_local') return 'local';
  return null;
}

// rsync 缺失时该往哪台设备装：远端缺失装在该 root 的设备上；
// 本地缺失时，本地 root 装自己，SSH root 装本机设备。
export function resolveRsyncInstallDeviceId(
  root: Pick<FileRootDto, 'deviceId' | 'deviceType'>,
  side: RsyncMissingSide,
  localDeviceId: string | null
): string | null {
  if (side === 'remote') return root.deviceId;
  return root.deviceType === 'local' ? root.deviceId : localDeviceId;
}

// reconcile：成功刷新后，「曾展开但已消失」的直接子目录应折叠。
// 必须排除本节点自身（path === '/' 时 parentOf('/') === '/' 会误判自身为子，
// 导致根 '/' 加载后自己折叠 → 闪一下就收起）。
export function staleChildExpansionPaths(
  expandedKeys: Iterable<string>,
  rootId: string,
  path: string,
  childDirPaths: ReadonlySet<string>
): string[] {
  const prefix = `${rootId}\n`;
  const stale: string[] = [];
  for (const key of expandedKeys) {
    if (!key.startsWith(prefix)) continue;
    const p = key.slice(prefix.length);
    if (p !== path && parentOf(p) === path && !childDirPaths.has(p)) stale.push(p);
  }
  return stale;
}

export interface UploadPlan<T> {
  accepted: T[];
  oversized: T[];
}

// 上传前按传输上限分流：超限文件只提示、不发起请求。
export function planUpload<T extends { size: number }>(
  files: readonly T[],
  maxBytes: number
): UploadPlan<T> {
  const accepted: T[] = [];
  const oversized: T[] = [];
  for (const file of files) {
    if (file.size > maxBytes) oversized.push(file);
    else accepted.push(file);
  }
  return { accepted, oversized };
}
