import { describe, expect, test } from 'bun:test';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { buildDeviceErrorBadge } from './device-status-badge-model';

const dict = zhCN.translation as unknown as Record<string, unknown>;

function t(key: string): string {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return typeof node === 'string' ? node : key;
}

describe('buildDeviceErrorBadge', () => {
  test('tmux_busy 用告警色，标签与 tooltip 取固定文案', () => {
    const model = buildDeviceErrorBadge(
      {
        type: 'tmux_busy',
        message: '主机负载过高，终端响应变慢，恢复后自动消失。',
        rawMessage: 'tmux control command timed out: send-keys -t %1',
      },
      t
    );
    expect(model.tone).toBe('warning');
    expect(model.label).toBe('主机繁忙');
    expect(model.tooltip).toBe('主机负载过高，终端响应变慢，恢复后自动消失。');
    expect(model.tooltip).not.toContain('send-keys');
  });

  test('其它错误类型保持错误色，tooltip 为标签 + 消息 + 原始信息', () => {
    const model = buildDeviceErrorBadge(
      { type: 'auth_failed', message: 'Auth failed', rawMessage: 'bad key' },
      t
    );
    expect(model.tone).toBe('error');
    expect(model.label).toBe('认证失败');
    expect(model.tooltip).toBe('认证失败\nAuth failed\nbad key');
  });

  test('未知类型落到「连接异常」', () => {
    const model = buildDeviceErrorBadge({ type: 'whatever', message: 'x' }, t);
    expect(model.label).toBe('连接异常');
    expect(model.tone).toBe('error');
    expect(model.tooltip).toBe('连接异常\nx');
  });
});
