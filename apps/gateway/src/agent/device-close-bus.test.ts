import { afterEach, describe, expect, test } from 'bun:test';
import { notifyDeviceClose, registerDeviceCloseListener } from './device-close-bus';

describe('device-close-bus', () => {
  afterEach(() => {
    registerDeviceCloseListener(null);
  });

  test('notifyDeviceClose 触发已注册 listener', () => {
    const received: string[] = [];
    registerDeviceCloseListener((deviceId) => {
      received.push(deviceId);
    });

    notifyDeviceClose('dev-1');
    notifyDeviceClose('dev-2');

    expect(received).toEqual(['dev-1', 'dev-2']);
  });

  test('registerDeviceCloseListener(null) 取消注册后 notify 不再触发', () => {
    const received: string[] = [];
    registerDeviceCloseListener((deviceId) => {
      received.push(deviceId);
    });
    registerDeviceCloseListener(null);

    notifyDeviceClose('dev-3');

    expect(received).toEqual([]);
  });

  test('后注册的 listener 覆盖先前的（单 listener 注册表语义）', () => {
    const first: string[] = [];
    const second: string[] = [];
    registerDeviceCloseListener((deviceId) => {
      first.push(deviceId);
    });
    registerDeviceCloseListener((deviceId) => {
      second.push(deviceId);
    });

    notifyDeviceClose('dev-4');

    expect(first).toEqual([]);
    expect(second).toEqual(['dev-4']);
  });

  test('未注册 listener 时 notifyDeviceClose 静默 no-op（不抛错）', () => {
    expect(() => notifyDeviceClose('dev-5')).not.toThrow();
  });
});
