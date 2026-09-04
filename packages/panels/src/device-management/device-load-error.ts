// 设备列表加载失败的分类：面板据此换文案，纯函数以便单测。

import { ApiError, isNodeLoginRequiredError, isNodeUnreachableError } from '@tmex/api-client';

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
