import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITY_DEVICE_LATENCY_V1 } from '@vibeterm/shared';
import { serverSupportsDeviceLatency, serverSupportsTermViewport } from './server-features';

describe('serverSupportsTermViewport', () => {
  test('1.1.7 起支持，更早的版本不发', () => {
    expect(serverSupportsTermViewport('1.1.6')).toBe(false);
    expect(serverSupportsTermViewport('1.1.7')).toBe(true);
    expect(serverSupportsTermViewport('2.0.0')).toBe(true);
  });

  test('版本缺失或解析不出时按新版处理', () => {
    expect(serverSupportsTermViewport(null)).toBe(true);
    expect(serverSupportsTermViewport('1.1.9_dev')).toBe(true);
  });
});

describe('serverSupportsDeviceLatency', () => {
  test('只认 HELLO 里播报的能力，不猜版本', () => {
    expect(serverSupportsDeviceLatency([GATEWAY_CAPABILITY_DEVICE_LATENCY_V1])).toBe(true);
    expect(serverSupportsDeviceLatency(['canonical-state-v1.1'])).toBe(false);
    expect(serverSupportsDeviceLatency([])).toBe(false);
    expect(serverSupportsDeviceLatency(undefined)).toBe(false);
  });
});
