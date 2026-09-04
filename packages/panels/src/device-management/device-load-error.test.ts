// 设备列表加载失败的分类与文案 key。

import { describe, expect, test } from 'bun:test';
import { ApiError, NODE_UNREACHABLE } from '@tmex/api-client';
import { describeDeviceLoadError, deviceLoadErrorMessageKey } from './device-load-error';

const NODE_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

describe('describeDeviceLoadError', () => {
  test('401 NODE_LOGIN_REQUIRED 归为「需重新登录」', () => {
    const error = new ApiError(401, 'via_mismatch', {
      code: 'NODE_LOGIN_REQUIRED',
      error: 'via_mismatch',
      nodeId: NODE_ID,
    });
    expect(describeDeviceLoadError(error)).toEqual({ kind: 'loginRequired', reason: null });
    expect(deviceLoadErrorMessageKey('loginRequired')).toBe('device.loadFailedLoginRequired');
  });

  test('503 NODE_UNREACHABLE 带出后端给的原因串', () => {
    const error = new ApiError(503, NODE_UNREACHABLE, {
      code: NODE_UNREACHABLE,
      nodeId: NODE_ID,
      reason: 'no link',
    });
    expect(describeDeviceLoadError(error)).toEqual({ kind: 'unreachable', reason: 'no link' });
  });

  test('没有 reason 的 NODE_UNREACHABLE 退回通用不可达文案', () => {
    const error = new ApiError(503, NODE_UNREACHABLE, { code: NODE_UNREACHABLE });
    expect(describeDeviceLoadError(error)).toEqual({ kind: 'unreachable', reason: null });
    expect(deviceLoadErrorMessageKey('unreachable')).toBe('device.loadFailedUnreachable');
  });

  test('其它失败（含裸 Error）归为通用失败', () => {
    expect(describeDeviceLoadError(new Error('boom'))).toEqual({ kind: 'generic', reason: null });
    expect(describeDeviceLoadError(new ApiError(500, 'boom'))).toEqual({
      kind: 'generic',
      reason: null,
    });
    expect(describeDeviceLoadError(undefined)).toEqual({ kind: 'generic', reason: null });
    expect(deviceLoadErrorMessageKey('generic')).toBe('device.loadFailed');
  });
});
