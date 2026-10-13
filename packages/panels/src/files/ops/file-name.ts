// 文件名的纯规则：校验（与后端 rename 同一套）、重名时的自动编号、扩展名拆分、错误文案键。

import { FileApiError, isFileRouteUnsupported } from '@vibeterm/api-client';
import { fileErrorKey } from '../file-tree-logic';

export type FileNameError = 'empty' | 'invalid' | 'tooLong';

export const FILE_NAME_MAX_BYTES = 255;

const FORBIDDEN_NAME_CHARS = /[/\\\0]/;

export function validateFileName(name: string): FileNameError | null {
  if (name.length === 0) return 'empty';
  if (name === '.' || name === '..' || FORBIDDEN_NAME_CHARS.test(name)) return 'invalid';
  if (new TextEncoder().encode(name).length > FILE_NAME_MAX_BYTES) return 'tooLong';
  return null;
}

const FILE_NAME_ERROR_KEYS: Record<FileNameError, string> = {
  empty: 'files.ops.nameEmpty',
  invalid: 'files.ops.nameInvalid',
  tooLong: 'files.ops.nameTooLong',
};

export function fileNameErrorKey(error: FileNameError): string {
  return FILE_NAME_ERROR_KEYS[error];
}

/** `base` 未被占用就原样返回，否则依次尝试 `base 2`、`base 3`…… */
export function uniqueChildName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/** 拆出主名与扩展名（扩展名带点）；`.env` 这类点文件整个算主名。 */
export function splitStem(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

// 先判「节点不认识这条路由」：旧节点的 404 可能带 `route_not_found` 这类非文件业务码。
export function fileOpErrorKey(error: unknown): string {
  if (isFileRouteUnsupported(error)) return 'files.ops.unsupported';
  if (error instanceof FileApiError) return fileErrorKey(error.code);
  return fileErrorKey();
}
