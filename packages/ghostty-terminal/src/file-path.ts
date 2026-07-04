// 纯 POSIX 路径工具：终端文件链接的解析与授权根校验。
// 浏览器侧运行，不依赖 node:path；不支持 `~`（前端无法得知远端 home）。

export interface FileLinkContext {
  /** 当前 pane 的工作目录（绝对路径），缺失时相对路径不可解析 */
  cwd?: string | null;
  /** 该设备已启用的授权根目录（绝对路径） */
  rootPaths: readonly string[];
}

/** 折叠 `.`/`..`/连续斜杠，输入必须以 `/` 开头；`..` 越过根按 POSIX 语义停在根。 */
export function normalizePosixPath(path: string): string {
  const stack: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

/** 把候选路径解析为绝对路径：绝对路径直接归一化，相对路径基于 cwd；无法解析返回 null。 */
export function resolvePathCandidate(
  rawPath: string,
  cwd: string | null | undefined
): string | null {
  if (rawPath.startsWith('/')) {
    return normalizePosixPath(rawPath);
  }
  if (!cwd || !cwd.startsWith('/')) {
    return null;
  }
  return normalizePosixPath(`${cwd}/${rawPath}`);
}

export function isWithinRoots(absPath: string, rootPaths: readonly string[]): boolean {
  for (const root of rootPaths) {
    if (!root.startsWith('/')) {
      continue;
    }
    const normRoot = normalizePosixPath(root);
    if (normRoot === '/') {
      return true;
    }
    if (absPath === normRoot || absPath.startsWith(`${normRoot}/`)) {
      return true;
    }
  }
  return false;
}

/** 候选路径 + 上下文 → 落在授权根内的绝对路径，否则 null。 */
export function resolveValidFilePath(
  rawPath: string,
  context: FileLinkContext | null
): string | null {
  if (!context || context.rootPaths.length === 0) {
    return null;
  }
  const resolved = resolvePathCandidate(rawPath, context.cwd);
  if (!resolved) {
    return null;
  }
  return isWithinRoots(resolved, context.rootPaths) ? resolved : null;
}
