import { PeerHandshakeError } from '../types';

/**
 * 客户端熔断按目标 node 计，不按会话。retryAfterMs 只是最短间隔，设太长会把别的标签一起冻住。
 * 真正挡住刷接口的是用户名额和节点上限；连续失败仍由客户端 30s 熔断接管。
 */
export const DIRECT_BUSY_RETRY_MS = {
  timeout: 1_000,
  aborted: 500,
  failed: 2_000,
  capacity: 1_000,
} as const;

export type DirectBusyReason = keyof typeof DIRECT_BUSY_RETRY_MS;

export class AuthorizeBusyError extends Error {
  readonly reason = 'capacity' as const;

  constructor() {
    super('browser authorize capacity');
    this.name = 'AuthorizeBusyError';
  }
}

export function failReason(err: unknown): string {
  if (err instanceof AuthorizeBusyError) return err.reason;
  if (err instanceof PeerHandshakeError) return err.code;
  if (isAbortError(err)) return 'aborted';
  return 'failed';
}

export function directBusyBody(err: unknown): { reason: DirectBusyReason; retryAfterMs: number } {
  const raw = failReason(err);
  const reason: DirectBusyReason =
    raw === 'timeout' || raw === 'aborted' || raw === 'capacity' ? raw : 'failed';
  return { reason, retryAfterMs: DIRECT_BUSY_RETRY_MS[reason] };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
