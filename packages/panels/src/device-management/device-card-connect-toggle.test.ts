// 连接状态 → 卡片主按钮动作的映射。

import { describe, expect, test } from 'bun:test';
import { deviceConnectAction } from './device-card-connect-toggle';

describe('deviceConnectAction', () => {
  test('已连接可断开', () => {
    expect(deviceConnectAction('connected')).toBe('disconnect');
  });

  test('连接中/重连中一律置为 pending（按钮禁用）', () => {
    expect(deviceConnectAction('connecting')).toBe('pending');
    expect(deviceConnectAction('reconnecting')).toBe('pending');
  });

  test('已断开与出错都能直接发起连接', () => {
    expect(deviceConnectAction('disconnected')).toBe('connect');
    expect(deviceConnectAction('error')).toBe('connect');
  });
});
