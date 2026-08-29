// 连接状态 → 卡片主按钮动作的映射，以及节点离线时的展示状态。

import { describe, expect, test } from 'bun:test';
import { deviceConnectAction, displayedConnectionStatus } from './device-card-connect-toggle';

describe('deviceConnectAction', () => {
  test('已连接可断开', () => {
    expect(deviceConnectAction('connected')).toBe('disconnect');
  });

  test('连接中 / 断开中 / 重连中一律置为 pending（按钮禁用）', () => {
    expect(deviceConnectAction('connecting')).toBe('pending');
    expect(deviceConnectAction('disconnecting')).toBe('pending');
    expect(deviceConnectAction('reconnecting')).toBe('pending');
  });

  test('已断开与出错都能直接发起连接', () => {
    expect(deviceConnectAction('disconnected')).toBe('connect');
    expect(deviceConnectAction('error')).toBe('connect');
  });
});

describe('displayedConnectionStatus', () => {
  test('节点离线且用户没发起过尝试：残留的任何状态都按 disconnected 展示（按钮可点）', () => {
    for (const status of [
      'connected',
      'connecting',
      'reconnecting',
      'error',
      'disconnecting',
    ] as const) {
      expect(displayedConnectionStatus(status, true)).toBe('disconnected');
      expect(displayedConnectionStatus(status, true, false)).toBe('disconnected');
    }
  });

  test('离线后用户手动尝试产生的 connecting / error / reconnecting 照常展示，connected 仍视为断开', () => {
    expect(displayedConnectionStatus('connecting', true, true)).toBe('connecting');
    expect(displayedConnectionStatus('error', true, true)).toBe('error');
    expect(displayedConnectionStatus('reconnecting', true, true)).toBe('reconnecting');
    expect(displayedConnectionStatus('connected', true, true)).toBe('disconnected');
  });

  test('在线时原样透传', () => {
    expect(displayedConnectionStatus('connected', false)).toBe('connected');
    expect(displayedConnectionStatus('disconnecting', false)).toBe('disconnecting');
  });
});
