// 传输错误码的唯一归一化入口。链路层（forwarder）用的是 `NODE_UNREACHABLE` 这类大写常量，
// 文件层用 `FileErrorCode`，契约要的是 `TransferErrorCode`——三者只在这里换算，
// 通道与任务运行器都调这一份，避免各自维护一张白名单后互相打架。

import type { TransferErrorCode } from '@vibeterm/shared';

const TRANSFER_ERROR_CODES: ReadonlySet<string> = new Set<TransferErrorCode>([
  'invalid',
  'outside_roots',
  'not_found',
  'not_a_directory',
  'is_directory',
  'too_large',
  'binary',
  'permission_denied',
  'device_not_found',
  'root_not_found',
  'root_disabled',
  'connection_failed',
  'auth_unsupported',
  'rsync_missing_local',
  'rsync_missing_remote',
  'timeout',
  'unknown',
  'node_unreachable',
  'grant_invalid',
  'grant_expired',
  'peer_mismatch',
  'offset_mismatch',
  'incomplete',
  'checksum_mismatch',
  'dest_exists',
  'dest_conflict',
  'limit_exceeded',
  'quota_file_size',
  'cancelled',
]);

/** 链路层常量 → 契约错误码。键一律先转小写再查。 */
const ALIASES: Readonly<Record<string, TransferErrorCode>> = {
  node_unreachable: 'node_unreachable',
  node_login_required: 'peer_mismatch',
  node_forbidden: 'permission_denied',
  no_link: 'node_unreachable',
  link_lost: 'node_unreachable',
  unavailable: 'node_unreachable',
  aborted: 'cancelled',
  aborterror: 'cancelled',
  timeouterror: 'timeout',
  io_error: 'unknown',
};

export function isTransferErrorCode(value: unknown): value is TransferErrorCode {
  return typeof value === 'string' && TRANSFER_ERROR_CODES.has(value);
}

/** 未知输入一律落到 `fallback`，绝不把任意字符串当成契约码抛出去。 */
export function normalizeTransferError(
  value: unknown,
  fallback: TransferErrorCode = 'unknown'
): TransferErrorCode {
  if (isTransferErrorCode(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const key = value.toLowerCase();
  if (isTransferErrorCode(key)) return key;
  return ALIASES[key] ?? fallback;
}

/** 取消要与失败分开判定：中止信号先于任何链路错误码。 */
export function isCancellation(value: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (value instanceof DOMException && value.name === 'AbortError') return true;
  return typeof value === 'string' && value.toLowerCase() === 'cancelled';
}

export function errorDetailOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}
