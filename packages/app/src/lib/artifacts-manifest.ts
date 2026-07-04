import { createHash } from 'node:crypto';

export interface ArtifactFileEntry {
  /** 相对产物根目录的 posix 路径 */
  path: string;
  sha256: string;
}

export interface ArtifactManifest {
  version: string;
  builtAt: string;
  files: ArtifactFileEntry[];
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 由文件内容清单生成 manifest；files 按 path 字典序排序，保证输出稳定 */
export function buildManifest(
  version: string,
  builtAt: string,
  files: Array<{ path: string; content: Uint8Array | string }>
): ArtifactManifest {
  const entries = files
    .map((file) => ({ path: file.path, sha256: sha256Hex(file.content) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version, builtAt, files: entries };
}
