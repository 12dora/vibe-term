// 中继确认位的判定：只有明确的 `relayAck:false` 才算没送达。

import { describe, expect, test } from 'bun:test';
import { RELAY_ACK_UNKNOWN, relayAckError, relayAckErrorText, warnRelayAck } from './relay-ack';

function recorder() {
  const calls: { key: string; options?: Record<string, unknown> }[] = [];
  const t = (key: string, options?: Record<string, unknown>) => {
    calls.push({ key, ...(options ? { options } : {}) });
    // 与 i18next 的 `defaultValue: ''` 一致：这里只关心 key 与参数，回声即可。
    return key;
  };
  return { calls, t };
}

describe('relayAckError', () => {
  test('中继确认过就没有错误', () => {
    expect(relayAckError({ relayAck: true })).toBeNull();
  });

  test('非中继模式与旧节点不下发该字段，一律按已送达处理', () => {
    expect(relayAckError({})).toBeNull();
    expect(relayAckError(undefined)).toBeNull();
    expect(relayAckError({ hubAck: true } as never)).toBeNull();
  });

  test('明确没确认时带出上联错误原文', () => {
    expect(relayAckError({ relayAck: false, relayError: 'offline' })).toBe('offline');
  });

  test('没确认但没给原因时退回 unknown', () => {
    expect(relayAckError({ relayAck: false })).toBe(RELAY_ACK_UNKNOWN);
    expect(relayAckError({ relayAck: false, relayError: '' })).toBe(RELAY_ACK_UNKNOWN);
  });
});

describe('relayAckErrorText', () => {
  test('查的是 relayAck 自己的错误表', () => {
    const { t } = recorder();
    expect(relayAckErrorText(t, 'timeout')).toBe('relay.tenant.relayAck.errors.timeout');
  });
});

describe('warnRelayAck', () => {
  test('已确认时一句都不发', () => {
    const { calls, t } = recorder();
    expect(warnRelayAck(t, { relayAck: true })).toBe(false);
    expect(calls).toEqual([]);
  });

  test('没确认时按告警文案渲染，错误原文作为参数带入', () => {
    const { calls, t } = recorder();
    expect(warnRelayAck(t, { relayAck: false, relayError: 'timeout' })).toBe(true);
    expect(calls.map((call) => call.key)).toEqual([
      'relay.tenant.relayAck.errors.timeout',
      'relay.tenant.relayAck.warning',
    ]);
    expect(calls[1].options).toEqual({ error: 'relay.tenant.relayAck.errors.timeout' });
  });
});
