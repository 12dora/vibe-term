// 凭据类 JSON 文件的共用读写：目录 0700、文件 0600，拒绝符号链接与 group/world 可读，
// 写入走同目录临时文件 + rename 的原子替换。会话文件与令牌文件共用。

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError, UsageError } from './errors';

export interface SecureFileKind {
  /** 报错里的文件称呼：`session` → `session file <path> ...`。 */
  noun: string;
  /** 说明这个文件为什么必须是 0600。 */
  sensitivity: string;
}

/** 符号链接一律拒绝；win32 的 mode 恒为 0666/0444，跳过权限位。 */
export function securePrivacyError(
  kind: SecureFileKind,
  path: string,
  info: { isSymbolicLink(): boolean; mode: number },
  platform: NodeJS.Platform = process.platform
): UsageError | null {
  if (info.isSymbolicLink()) {
    return new UsageError(
      `${kind.noun} file ${path} is a symlink; refuse to load a redirected ${kind.noun} file`
    );
  }
  if (platform === 'win32') return null;
  if ((info.mode & 0o077) !== 0) {
    return new UsageError(
      `${kind.noun} file ${path} is group/world readable; chmod 0600 (${kind.sensitivity})`
    );
  }
  return null;
}

/** 隐私检查不过抛 CliError；文件缺失 / 损坏 / 读失败一律退回 `empty()`。 */
export function loadSecureJson<T>(
  kind: SecureFileKind,
  path: string,
  parse: (text: string) => T,
  empty: () => T
): T {
  try {
    const error = securePrivacyError(kind, path, lstatSync(path));
    if (error) throw error;
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof CliError) throw error;
    return empty();
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 原子写：先写同目录临时文件（0600）再 rename，避免半截文件被下次读到。
 * 只 chmod 本次新建的目录，或 CLI 自有 config dir；用户指定的已存在目录原样保留。
 */
export function saveSecureJson(path: string, ownDir: string | null, data: unknown): void {
  const dir = dirname(path);
  const existed = directoryExists(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const isOwnDir = ownDir !== null && resolve(dir) === resolve(ownDir);
  if (!existed || isOwnDir) chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
