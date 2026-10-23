// 传输失败的原因文案：把 api-client 抛出的各类错误落成一行简短的人话。

import {
  ApiError,
  FileApiError,
  TransferInterruptedError,
  isFileRouteUnsupported,
} from '@vibeterm/api-client';
import type { TFunction } from 'i18next';
import { fileOpErrorKey } from './ops';

/** 浏览器宿主保存文件失败（传输本身已成功）。 */
export class SaveFileError extends Error {
  constructor(cause: unknown) {
    super('save file failed', { cause });
    this.name = 'SaveFileError';
  }
}

/**
 * 下载 / 上传里有意义的文件错误码。`too_large`（预览专用文案）与 `binary` 不在其中：
 * 传输场景下它们要么另有专属文案，要么不该出现。
 */
const FILE_OP_CODES: ReadonlySet<string> = new Set([
  'invalid',
  'outside_roots',
  'not_found',
  'not_a_directory',
  'is_directory',
  'permission_denied',
  'already_exists',
  'device_not_found',
  'root_not_found',
  'root_disabled',
  'root_virtual',
  'connection_failed',
  'auth_unsupported',
  'rsync_missing_local',
  'rsync_missing_remote',
  'timeout',
]);

// 转发层错误码（api-client 只在包内引用 NODE_LOGIN_REQUIRED，未导出）
const NODE_LOGIN_REQUIRED = 'NODE_LOGIN_REQUIRED';
const NODE_UNREACHABLE = 'NODE_UNREACHABLE';
const SOURCE_CHANGED_DETAIL = 'source changed';

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function describeApiError(error: FileApiError, t: TFunction): string | null {
  const code: string | undefined = error.code;
  if (code === 'too_large') return t('files.transfer.error.too_large');
  if (code === 'invalid' && error.detail === SOURCE_CHANGED_DETAIL) {
    return t('files.transfer.error.source_changed');
  }
  if (isFileRouteUnsupported(error) || (code !== undefined && FILE_OP_CODES.has(code))) {
    return t(fileOpErrorKey(error));
  }
  return null;
}

// `/n/<id>` 转发层的失败（401 / 503）FileApiError 与 ApiError 两种形态都可能出现
function describeForwarderError(error: unknown, t: TFunction): string | null {
  if (!(error instanceof FileApiError) && !(error instanceof ApiError)) return null;
  const code: string | null | undefined = error.code;
  if (error.status === 401 || code === NODE_LOGIN_REQUIRED) {
    return t('files.transfer.error.login_required');
  }
  if (code === NODE_UNREACHABLE) {
    return t('devices.transfer.errors.node_unreachable');
  }
  // 没带业务错误码的 5xx 是代理 / 网关层的失败（502、504 的 HTML 页等），对用户就是链路问题
  if (error.status >= 500 && !code) return t('files.transfer.error.network');
  return null;
}

/**
 * 一行失败原因；用户取消（AbortError）返回空串，由调用方按取消处理。
 * 不认识的错误一律「未知」：原始异常文案是英文机器话，不展示给用户。
 */
export function describeTransferError(error: unknown, t: TFunction): string {
  if (isAbortError(error)) return '';
  if (error instanceof TransferInterruptedError || error instanceof TypeError) {
    return t('files.transfer.error.network');
  }
  if (error instanceof SaveFileError) return t('files.transfer.error.save_failed');
  const known =
    describeForwarderError(error, t) ??
    (error instanceof FileApiError ? describeApiError(error, t) : null);
  return known ?? t('common.unknown');
}

export interface TransferFailure {
  name: string;
  error: unknown;
}

/** 批量失败的说明：最多列出 `maxLines` 条「文件名: 原因」，超出的以省略号收尾。 */
export function describeBatchFailures(
  failures: readonly TransferFailure[],
  t: TFunction,
  maxLines = 3
): string {
  const lines = failures.slice(0, maxLines).map(({ name, error }) => {
    const reason = describeTransferError(error, t) || t('common.unknown');
    return `${name}: ${reason}`;
  });
  if (failures.length > maxLines) lines.push('…');
  return lines.join('\n');
}
