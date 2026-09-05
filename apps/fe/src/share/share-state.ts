// 被分享页的状态机：loading → password → terminal → ended。纯函数，无 React / 网络。

import type { ShareAccessErrorCode, ShareAccessInfo } from './access-client';

export type ShareViewStatus = 'loading' | 'password' | 'terminal' | 'ended';

/** 结束原因决定 ended 屏上那一行文案 */
export type ShareEndedReason = 'ended' | 'notFound' | 'unavailable';

export interface ShareViewState {
  status: ShareViewStatus;
  /** 分享名称；尚未拿到时为 null，界面回落到默认名 */
  name: string | null;
  expiresAt: number | null;
  deviceId: string | null;
  windowId: string | null;
  /** 密码表单上的一行错误 */
  error: ShareAccessErrorCode | null;
  /** 限速锁定的解除时刻（epoch ms） */
  lockedUntil: number | null;
  submitting: boolean;
  endedReason: ShareEndedReason | null;
}

export const INITIAL_SHARE_VIEW_STATE: ShareViewState = {
  status: 'loading',
  name: null,
  expiresAt: null,
  deviceId: null,
  windowId: null,
  error: null,
  lockedUntil: null,
  submitting: false,
  endedReason: null,
};

export type ShareViewAction =
  /** `GET /api/share-access/:id` 的结果（登录成功后也会再取一次） */
  | { type: 'access'; info: ShareAccessInfo }
  | { type: 'access-failed'; code: ShareAccessErrorCode }
  | { type: 'submit' }
  | { type: 'login-failed'; code: ShareAccessErrorCode; retryAfterMs: number | null; now: number }
  /** ws 4410 / 主动断开 */
  | { type: 'ended' }
  /** ws 4401：凭证失效，回到密码表单 */
  | { type: 'login-required' };

const ENDED_BY_CODE: Partial<Record<ShareAccessErrorCode, ShareEndedReason>> = {
  SHARE_NOT_FOUND: 'notFound',
  SHARE_ENDED: 'ended',
};

function ended(state: ShareViewState, reason: ShareEndedReason): ShareViewState {
  return {
    ...state,
    status: 'ended',
    endedReason: reason,
    submitting: false,
    error: null,
    lockedUntil: null,
  };
}

function applyAccess(state: ShareViewState, info: ShareAccessInfo): ShareViewState {
  const next = { ...state, name: info.name || state.name, expiresAt: info.expiresAt };
  if (info.state === 'ended') return ended(next, 'ended');
  if (info.authenticated && info.deviceId && info.windowId) {
    return {
      ...next,
      status: 'terminal',
      deviceId: info.deviceId,
      windowId: info.windowId,
      error: null,
      lockedUntil: null,
      submitting: false,
    };
  }
  return { ...next, status: 'password', deviceId: null, windowId: null, submitting: false };
}

function applyLoginFailure(
  state: ShareViewState,
  action: Extract<ShareViewAction, { type: 'login-failed' }>
): ShareViewState {
  if (action.code === 'SHARE_ENDED') return ended(state, 'ended');
  if (action.code === 'SHARE_NOT_FOUND') return ended(state, 'notFound');
  return {
    ...state,
    status: 'password',
    submitting: false,
    error: action.code,
    lockedUntil:
      action.code === 'SHARE_LOGIN_LOCKED' && action.retryAfterMs
        ? action.now + action.retryAfterMs
        : null,
  };
}

export function shareViewReducer(state: ShareViewState, action: ShareViewAction): ShareViewState {
  switch (action.type) {
    case 'access':
      return applyAccess(state, action.info);
    case 'access-failed':
      return ended(state, ENDED_BY_CODE[action.code] ?? 'unavailable');
    case 'submit':
      return { ...state, submitting: true, error: null };
    case 'login-failed':
      return applyLoginFailure(state, action);
    case 'ended':
      return ended(state, 'ended');
    case 'login-required':
      return {
        ...state,
        status: 'password',
        deviceId: null,
        windowId: null,
        submitting: false,
        error: null,
        lockedUntil: null,
      };
  }
}

/** 锁定剩余秒数（向上取整）；未锁定为 0。 */
export function shareLockSeconds(lockedUntil: number | null, now: number): number {
  if (!lockedUntil || lockedUntil <= now) return 0;
  return Math.ceil((lockedUntil - now) / 1000);
}
