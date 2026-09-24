// 设备列表加载失败的分类：面板据此换文案，纯函数以便单测。

import { ApiError, isNodeLoginRequiredError, isNodeUnreachableError } from '@vibeterm/api-client';

export type DeviceLoadErrorKind = 'loginRequired' | 'unreachable' | 'generic';

export interface DeviceLoadErrorInfo {
  kind: DeviceLoadErrorKind;
  /** 后端给出的可安全展示的原因串；没有则 null。 */
  reason: string | null;
}

const MESSAGE_KEYS: Record<DeviceLoadErrorKind, string> = {
  loginRequired: 'device.loadFailedLoginRequired',
  unreachable: 'device.loadFailedUnreachable',
  generic: 'device.loadFailed',
};

/**
 * 转发器 `NODE_UNREACHABLE.reason` 的安全字面量 → 已有的链路失败文案。原样把 `timeout`
 * 这类英文代号拼进句子没有意义；认不出的一律不带原因，退回通用的「节点不可达」。
 */
const UNREACHABLE_REASON_KEYS: ReadonlyMap<string, string> = new Map([
  ['timeout', 'nodes.badge.failure.timeout'],
  ['no_link', 'nodes.badge.failure.unreachable'],
  ['not_admitted', 'nodes.badge.failure.untrusted'],
  ['link_lost', 'nodes.badge.failure.reset'],
  ['handshake_failed', 'nodes.badge.failure.handshake'],
  ['relay_reset:offline', 'nodes.badge.failure.unreachable'],
  ['relay_reset:self-target', 'nodes.badge.failure.reset'],
  ['relay_reset:unknown-target', 'nodes.badge.failure.reset'],
  ['relay_reset:quota-streams', 'nodes.badge.failure.reset'],
  ['relay_reset:open-failed', 'nodes.badge.failure.reset'],
]);

export function unreachableReasonKey(reason: string | null): string | null {
  return (reason && UNREACHABLE_REASON_KEYS.get(reason)) || null;
}

export function describeDeviceLoadError(error: unknown): DeviceLoadErrorInfo {
  if (isNodeLoginRequiredError(error)) return { kind: 'loginRequired', reason: null };
  if (isNodeUnreachableError(error)) {
    return { kind: 'unreachable', reason: error instanceof ApiError ? error.reason : null };
  }
  return { kind: 'generic', reason: null };
}

export function deviceLoadErrorMessageKey(kind: DeviceLoadErrorKind): string {
  return MESSAGE_KEYS[kind];
}
