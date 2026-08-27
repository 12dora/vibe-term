// 纯 POSIX 路径工具：前后端共用的 basename / dirname / 规范化，不依赖 node:path。

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return name || path;
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '/';
}

export interface NormalizePosixPathOptions {
  /**
   * 强制按相对路径归一：结果不带前导 `/`，越过起点的 `..` 段原样保留。
   * 缺省按 path 是否以 `/` 开头自动判断；绝对路径下 `..` 越过根按 POSIX 语义停在根。
   */
  relative?: boolean;
}

/** 折叠 `.` / `..` / 连续斜杠。 */
export function normalizePosixPath(path: string, options: NormalizePosixPathOptions = {}): string {
  const relative = options.relative ?? !path.startsWith('/');
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (relative) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  return relative ? joined : `/${joined}`;
}
