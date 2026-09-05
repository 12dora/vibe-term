// 「添加设备」的两条通路：全局事件（单面板宿主）与显式回调 / ref（多面板聚合宿主）。
// bun test 无 DOM，这里直接测两个被面板与动作按钮共用的纯函数。

import { afterEach, describe, expect, test } from 'bun:test';
import { requestAddDevice } from './device-management-actions';
import { subscribeOpenAddDevice } from './device-management-panel';
import { type AddDevicePreset, OPEN_ADD_DEVICE_EVENT, addDevicePresetFromEvent } from './events';

interface WindowProbe {
  added: string[];
  removed: string[];
  dispatched: string[];
  listeners: Map<string, (event: Event) => void>;
  emit: (type: string, detail?: unknown) => void;
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWindowProbe(): WindowProbe {
  const listeners = new Map<string, (event: Event) => void>();
  const probe: WindowProbe = {
    added: [],
    removed: [],
    dispatched: [],
    listeners,
    emit: (type, detail) => listeners.get(type)?.({ type, detail } as unknown as Event),
  };
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        probe.added.push(type);
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        probe.removed.push(type);
        listeners.delete(type);
      },
      dispatchEvent: (event: Event) => {
        probe.dispatched.push(event.type);
        listeners.get(event.type)?.(event);
        return true;
      },
    },
    configurable: true,
    writable: true,
  });
  return probe;
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('subscribeOpenAddDevice', () => {
  test('enabled=true 时注册全局监听，清理函数摘掉它', () => {
    const probe = installWindowProbe();
    const unsubscribe = subscribeOpenAddDevice(true, () => undefined);

    expect(probe.added).toEqual([OPEN_ADD_DEVICE_EVENT]);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe?.();
    expect(probe.removed).toEqual([OPEN_ADD_DEVICE_EVENT]);
  });

  test('enabled=false 时一个监听都不注册：多面板宿主不会被一次事件全部弹开', () => {
    const probe = installWindowProbe();
    const unsubscribe = subscribeOpenAddDevice(false, () => undefined);

    expect(probe.added).toEqual([]);
    expect(unsubscribe).toBeUndefined();
  });
});

describe('requestAddDevice', () => {
  test('没有回调时派发全局事件', () => {
    const probe = installWindowProbe();
    requestAddDevice();
    expect(probe.dispatched).toEqual([OPEN_ADD_DEVICE_EVENT]);
  });

  test('有回调时只走回调，不派发全局事件', () => {
    const probe = installWindowProbe();
    let called = 0;
    requestAddDevice(() => {
      called += 1;
    });
    expect(called).toBe(1);
    expect(probe.dispatched).toEqual([]);
  });

  test('预选类型随回调与全局事件一起走', () => {
    installWindowProbe();
    let viaCallback: AddDevicePreset | undefined;
    requestAddDevice(
      (preset) => {
        viaCallback = preset;
      },
      { type: 'ssh' }
    );
    expect(viaCallback).toEqual({ type: 'ssh' });

    const probe = installWindowProbe();
    let viaEvent: AddDevicePreset | undefined;
    subscribeOpenAddDevice(true, (preset) => {
      viaEvent = preset;
    });
    requestAddDevice(undefined, { type: 'ssh' });
    expect(viaEvent).toEqual({ type: 'ssh' });
    expect(probe.dispatched).toEqual([OPEN_ADD_DEVICE_EVENT]);
  });
});

describe('addDevicePresetFromEvent', () => {
  test('认约定里的类型', () => {
    expect(addDevicePresetFromEvent({ detail: { type: 'ssh' } } as unknown as Event)).toEqual({
      type: 'ssh',
    });
    expect(addDevicePresetFromEvent({ detail: { type: 'local' } } as unknown as Event)).toEqual({
      type: 'local',
    });
  });

  test('detail 不是约定形状时当作没有预选：旧派发方与外部事件都不能把对话框带偏', () => {
    for (const detail of [null, undefined, 'ssh', 42, {}, { type: 'serial' }]) {
      expect(addDevicePresetFromEvent({ detail } as unknown as Event)).toBeUndefined();
    }
  });
});
