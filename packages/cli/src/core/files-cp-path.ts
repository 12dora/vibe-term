// scp 风格 `<node>:<path>` 到文件根的解析（cp 用）：绝对路径取最长前缀根，相对路径先认 `<root>/` 再落 home。

import type { CliContext } from './context';
import { NotFoundError, UsageError } from './errors';
import {
  type FileRootDto,
  isUserFileRoot,
  listFileRoots,
  resolveFileRoot,
  resolveVirtualFsRoot,
} from './files-api';
import {
  type CpFileRef,
  VIRTUAL_HOME_ROOT_ID,
  isPathInside,
  joinRootPath,
  normalizePosixPath,
} from './files-path';

export interface CpPathScope {
  /** 只在该设备的文件根里找；省略 = 节点的默认（首个本机）设备。 */
  deviceId: string | null;
  /** 调用方显式指定了设备（此时不再用旧式 `<root>/` 跨设备匹配，也不合成 fs-root）。 */
  explicit: boolean;
}

export interface LocatedPath {
  root: FileRootDto;
  absPath: string;
}

function tryResolveRoot(roots: readonly FileRootDto[], ref: string): FileRootDto | null {
  try {
    return resolveFileRoot(roots, ref);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

function homeRootOrThrow(roots: readonly FileRootDto[], label: string): FileRootDto {
  const home = tryResolveRoot(roots, VIRTUAL_HOME_ROOT_ID);
  if (home) return home;
  throw new NotFoundError(
    `${label} 没有可用的 home 根`,
    '改用绝对路径，或 <node>:<root>/<path> 形式'
  );
}

function defaultDeviceId(roots: readonly FileRootDto[]): string | null {
  const home = tryResolveRoot(roots, VIRTUAL_HOME_ROOT_ID);
  if (home?.deviceId) return home.deviceId;
  const locals = roots
    .filter((root) => root.enabled && root.deviceType === 'local' && root.deviceId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return locals[0]?.deviceId ?? null;
}

function rootsOnDevice(roots: readonly FileRootDto[], scope: CpPathScope): FileRootDto[] {
  if (!scope.deviceId) return [...roots];
  return roots.filter((root) => root.deviceId === scope.deviceId);
}

function pickLongestRoot(candidates: readonly FileRootDto[], absPath: string): FileRootDto | null {
  let best: { root: FileRootDto; path: string } | null = null;
  for (const root of candidates) {
    if (!root.enabled) continue;
    const rootPath = normalizePosixPath(root.path);
    if (!isPathInside(rootPath, absPath)) continue;
    if (!best || rootPath.length > best.path.length) best = { root, path: rootPath };
    else if (
      rootPath.length === best.path.length &&
      isUserFileRoot(root) &&
      !isUserFileRoot(best.root)
    ) {
      best = { root, path: rootPath };
    }
  }
  return best?.root ?? null;
}

/** scp 语义的 `<node>:<path>` 落到具体文件根：绝对路径取最长前缀根；相对路径先认旧式 `<root>/`，否则相对 home。 */
export function locateCpPath(
  roots: readonly FileRootDto[],
  path: string,
  scope: CpPathScope,
  label: string
): LocatedPath {
  if (path.startsWith('/')) return locateAbsolute(roots, normalizePosixPath(path), scope, label);
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length > 0) {
    const pool = scope.explicit ? rootsOnDevice(roots, scope) : roots;
    const legacy = tryResolveRoot(pool, segments[0]);
    if (legacy) {
      return { root: legacy, absPath: joinRootPath(legacy.path, segments.slice(1).join('/')) };
    }
  }
  const home = homeRootOrThrow(roots, label);
  if (scope.explicit && scope.deviceId && home.deviceId !== scope.deviceId) {
    throw new UsageError(
      `该设备在 ${label} 上没有 home 根`,
      '请使用绝对路径，或 <node>:<root>/<path> 形式'
    );
  }
  return { root: home, absPath: joinRootPath(home.path, segments.join('/')) };
}

function locateAbsolute(
  roots: readonly FileRootDto[],
  absPath: string,
  scope: CpPathScope,
  label: string
): LocatedPath {
  const candidates = rootsOnDevice(roots, scope);
  if (!scope.explicit && !roots.some((root) => root.enabled && isUserFileRoot(root))) {
    candidates.push(resolveVirtualFsRoot(roots));
  }
  const root = pickLongestRoot(candidates, absPath);
  if (!root) {
    throw new UsageError(
      `路径 ${absPath} 不在 ${label} 的文件根内；可在设置中添加文件根，或改用 rsync -e 'vibeterm rsh'`
    );
  }
  return { root, absPath };
}

async function cpScope(
  ctx: CliContext,
  nodeId: string,
  roots: readonly FileRootDto[],
  device: string | undefined
): Promise<CpPathScope> {
  if (device) {
    return { deviceId: (await ctx.resolver.resolveDevice(nodeId, device)).id, explicit: true };
  }
  return { deviceId: defaultDeviceId(roots), explicit: false };
}

export async function resolveCpPath(
  ctx: CliContext,
  ref: CpFileRef,
  options: { device?: string } = {}
): Promise<{ nodeId: string; root: FileRootDto; absPath: string }> {
  const nodeId = ref.node
    ? (await ctx.resolver.resolveNode(ref.node)).id
    : await ctx.targetNodeId();
  const roots = await listFileRoots(ctx.http, nodeId);
  if (ref.form === 'root') {
    const root = resolveFileRoot(roots, ref.root);
    return { nodeId, root, absPath: joinRootPath(root.path, ref.relpath) };
  }
  const scope = await cpScope(ctx, nodeId, roots, options.device);
  return { nodeId, ...locateCpPath(roots, ref.path, scope, ref.node ?? '当前节点') };
}
