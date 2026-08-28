import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { NotificationOptions } from '@tmex/notifications';
import type { EventDevicePayload, EventTmuxPayload, SiteSettings } from '@tmex/shared';
import { createGatewayConnection } from '@tmex/ws-client';
import type { HostServices } from './runtime';
import { installWindowStorage } from './test-utils';
import type { TmuxDomainEventContext } from './tmux-device-events';
import type { TmuxState } from './tmux-state';

installWindowStorage();

const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

const { createAppRuntime } = await import('./app-runtime');
const { handleDeviceEvent, handleTmuxEvent } = await import('./tmux-device-events');

const BASE_SETTINGS: SiteSettings = {
  siteName: 'tmex',
  siteUrl: 'http://localhost:9663',
  bellThrottleSeconds: 0,
  notificationThrottleSeconds: 0,
  enableBrowserNotificationToast: true,
  enableNotificationPush: true,
  enableBellPush: true,
  enableBellSound: true,
  sshReconnectMaxRetries: 3,
  sshReconnectDelaySeconds: 5,
  language: 'zh_CN',
  theme: 'dark',
  disabledNotificationChannels: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface ToastRecord {
  title: string;
  options?: NotificationOptions;
}

interface Harness {
  ctx: TmuxDomainEventContext;
  infos: ToastRecord[];
  errors: ToastRecord[];
  bellPlays: string[];
  navigations: string[];
  cleanedDevices: string[];
  state(): TmuxState;
  setSettings(overrides: Partial<SiteSettings>): void;
}

function fakeHost(navigations: string[]): HostServices {
  return {
    navigate: (to) => {
      navigations.push(to);
    },
    isMobile: () => false,
    openMobileSidebar: () => {},
    closeMobileSidebar: () => {},
    writeClipboardText: async () => {},
    readClipboardText: async () => '',
    openExternal: () => {},
    reload: () => {},
    saveFile: () => {},
  };
}

let harnessSeq = 0;
const disposers: Array<() => void> = [];

function makeHarness(hostManagedNotifications = false): Harness {
  harnessSeq += 1;
  const connection = createGatewayConnection({ wsUrl: 'ws://device-events.test/ws' });
  const infos: ToastRecord[] = [];
  const errors: ToastRecord[] = [];
  const bellPlays: string[] = [];
  const navigations: string[] = [];
  const cleanedDevices: string[] = [];
  connection.selectMachine.cleanup = (deviceId: string) => {
    cleanedDevices.push(deviceId);
  };
  const runtime = createAppRuntime({
    connection,
    storagePrefix: `device-events-${harnessSeq}:`,
    features: { agentUi: false, hostManagedNotifications },
    t: (key) => String(key),
    host: fakeHost(navigations),
    bell: {
      play: () => {
        bellPlays.push('play');
      },
    },
    notifications: {
      info: (title, options) => {
        infos.push({ title, options });
      },
      success: () => {},
      warning: () => {},
      error: (title, options) => {
        errors.push({ title, options });
      },
    },
  });
  disposers.push(() => {
    runtime.dispose();
    connection.dispose();
  });
  return {
    ctx: {
      core: runtime,
      getState: runtime.stores.tmux.getState,
      setState: runtime.stores.tmux.setState,
      getSite: () => runtime.stores.site,
    },
    infos,
    errors,
    bellPlays,
    navigations,
    cleanedDevices,
    state: runtime.stores.tmux.getState,
    setSettings: (overrides) => {
      runtime.stores.site.setState({ settings: { ...BASE_SETTINGS, ...overrides } });
    },
  };
}

function tmuxEvent(type: EventTmuxPayload['type'], data: unknown): EventTmuxPayload {
  return { deviceId: 'device-1', type, data };
}

function deviceEvent(payload: Partial<EventDevicePayload> & Pick<EventDevicePayload, 'type'>) {
  return { deviceId: 'device-1', ...payload };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  const { useBellStore } = await import('@tmex/notifications');
  for (const paneId of Object.keys(useBellStore.getState().ringingPanes)) {
    useBellStore.getState().clearBell(paneId);
  }
});

describe('handleTmuxEvent bell', () => {
  test('高亮 paneId 并播放提示音', async () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('bell', { paneId: '%bell-1' }));
    const { useBellStore } = await import('@tmex/notifications');
    expect(useBellStore.getState().ringingPanes['%bell-1']).toBe(true);
    expect(h.bellPlays).toHaveLength(1);
  });

  test('缺少 paneId 时回落到 windowId', async () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('bell', { windowId: '@bell-2' }));
    const { useBellStore } = await import('@tmex/notifications');
    expect(useBellStore.getState().ringingPanes['@bell-2']).toBe(true);
  });

  test('data 缺省或无可用 id 时只播放提示音', async () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('bell', undefined));
    handleTmuxEvent(h.ctx, tmuxEvent('bell', { paneId: 42 }));
    const { useBellStore } = await import('@tmex/notifications');
    expect(Object.keys(useBellStore.getState().ringingPanes)).toHaveLength(0);
    expect(h.bellPlays).toHaveLength(2);
  });

  test('enableBellSound=false 时仍高亮但不发声', async () => {
    const h = makeHarness();
    h.setSettings({ enableBellSound: false });
    handleTmuxEvent(h.ctx, tmuxEvent('bell', { paneId: '%bell-3' }));
    const { useBellStore } = await import('@tmex/notifications');
    expect(useBellStore.getState().ringingPanes['%bell-3']).toBe(true);
    expect(h.bellPlays).toHaveLength(0);
  });

  test('宿主接管通知不影响 bell', async () => {
    const h = makeHarness(true);
    handleTmuxEvent(h.ctx, tmuxEvent('bell', { paneId: '%bell-4' }));
    const { useBellStore } = await import('@tmex/notifications');
    expect(useBellStore.getState().ringingPanes['%bell-4']).toBe(true);
    expect(h.bellPlays).toHaveLength(1);
  });
});

describe('handleTmuxEvent notification', () => {
  test('弹出 info toast 并带 pane 位置描述', () => {
    const h = makeHarness();
    handleTmuxEvent(
      h.ctx,
      tmuxEvent('notification', {
        title: 'Build done',
        body: 'exit 0',
        windowIndex: 1,
        paneIndex: 2,
      })
    );
    expect(h.infos).toHaveLength(1);
    expect(h.infos[0]?.title).toBe('Build done');
    expect(h.infos[0]?.options?.description).toContain('exit 0');
  });

  test('paneUrl 存在时挂 Open 动作并交给 host 导航', () => {
    const h = makeHarness();
    handleTmuxEvent(
      h.ctx,
      tmuxEvent('notification', { title: 'x', paneUrl: '/devices/d/panes/%1' })
    );
    const action = h.infos[0]?.options?.action;
    expect(action?.label).toBe('Open');
    action?.onClick();
    expect(h.navigations).toEqual(['/devices/d/panes/%1']);
  });

  test('缺少 paneUrl 时不挂动作', () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('notification', { title: 'x' }));
    expect(h.infos[0]?.options?.action).toBeUndefined();
  });

  test('宿主接管通知时不弹 toast', () => {
    const h = makeHarness(true);
    handleTmuxEvent(h.ctx, tmuxEvent('notification', { title: 'x' }));
    expect(h.infos).toHaveLength(0);
  });

  test('enableBrowserNotificationToast=false 时不弹 toast', () => {
    const h = makeHarness();
    h.setSettings({ enableBrowserNotificationToast: false });
    handleTmuxEvent(h.ctx, tmuxEvent('notification', { title: 'x' }));
    expect(h.infos).toHaveLength(0);
  });

  test('无 title 时回落到 i18n key', () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('notification', { source: 'osc9' }));
    expect(h.infos[0]?.title).toBe('terminal.notificationFallbackTitle');
  });
});

describe('handleTmuxEvent pane-active', () => {
  test('记录事件上报的活动 pane', () => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent('pane-active', { windowId: '@1', paneId: '%1' }));
    expect(h.state().activePaneFromEvent['device-1']).toEqual({ windowId: '@1', paneId: '%1' });
  });

  test.each([[undefined], [{ windowId: '@1' }], [{ paneId: '%1' }], [{}]])(
    'data 不完整时不写状态 (%p)',
    (data) => {
      const h = makeHarness();
      handleTmuxEvent(h.ctx, tmuxEvent('pane-active', data));
      expect(h.state().activePaneFromEvent['device-1']).toBeUndefined();
    }
  );
});

describe('handleTmuxEvent 其它事件类型', () => {
  test.each([
    ['window-add'],
    ['window-close'],
    ['window-renamed'],
    ['window-active'],
    ['pane-add'],
    ['pane-close'],
    ['layout-change'],
    ['output'],
  ] as const)('%s 不产生副作用', (type) => {
    const h = makeHarness();
    handleTmuxEvent(h.ctx, tmuxEvent(type, { windowId: '@1', paneId: '%1' }));
    expect(h.infos).toHaveLength(0);
    expect(h.bellPlays).toHaveLength(0);
    expect(h.state().activePaneFromEvent['device-1']).toBeUndefined();
  });
});

describe('handleDeviceEvent', () => {
  test('error 写入 deviceErrors 并弹一次 toast', () => {
    const h = makeHarness();
    handleDeviceEvent(
      h.ctx,
      deviceEvent({
        type: 'error',
        errorType: 'connection_closed',
        message: 'Connection closed',
        rawMessage: 'read ECONNRESET',
      })
    );
    const error = h.state().deviceErrors['device-1'];
    expect(error?.type).toBe('connection_closed');
    expect(error?.message).toBe('Connection closed');
    expect(error?.rawMessage).toBe('read ECONNRESET');
    expect(h.errors.map((item) => item.title)).toEqual(['Connection closed']);
  });

  test('同类型错误重复上报不再弹 toast，换类型才再弹', () => {
    const h = makeHarness();
    const payload = deviceEvent({
      type: 'error',
      errorType: 'auth_failed',
      message: 'Auth failed',
    });
    handleDeviceEvent(h.ctx, payload);
    handleDeviceEvent(h.ctx, payload);
    expect(h.errors).toHaveLength(1);
    handleDeviceEvent(
      h.ctx,
      deviceEvent({ type: 'error', errorType: 'timeout', message: 'Timed out' })
    );
    expect(h.errors.map((item) => item.title)).toEqual(['Auth failed', 'Timed out']);
  });

  test('缺省 message / errorType 时用兜底值', () => {
    const h = makeHarness();
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'error' }));
    expect(h.state().deviceErrors['device-1']).toMatchObject({
      message: 'Device Error',
      type: 'unknown',
    });
    expect(h.errors.map((item) => item.title)).toEqual(['Device Error']);
  });

  test('宿主接管通知时只写状态不弹 toast', () => {
    const h = makeHarness(true);
    handleDeviceEvent(
      h.ctx,
      deviceEvent({ type: 'error', errorType: 'connection_closed', message: 'Connection closed' })
    );
    expect(h.state().deviceErrors['device-1']?.type).toBe('connection_closed');
    expect(h.errors).toHaveLength(0);
  });

  test('reconnecting 只写 deviceReconnecting，不写 deviceErrors 也不弹 toast', () => {
    const h = makeHarness();
    handleDeviceEvent(
      h.ctx,
      deviceEvent({ type: 'error', errorType: 'reconnecting', message: 'Reconnecting…' })
    );
    expect(h.state().deviceReconnecting['device-1']?.message).toBe('Reconnecting…');
    expect(h.state().deviceErrors['device-1']).toBeUndefined();
    expect(h.errors).toHaveLength(0);
  });

  test('非 reconnecting 的 error 清空 deviceReconnecting', () => {
    const h = makeHarness();
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'error', errorType: 'reconnecting' }));
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'error', errorType: 'auth_failed' }));
    expect(h.state().deviceReconnecting['device-1']).toBeUndefined();
  });

  test('disconnected 清理 select 状态并置连接位', () => {
    const h = makeHarness();
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'disconnected' }));
    expect(h.cleanedDevices).toEqual(['device-1']);
    expect(h.state().deviceConnected['device-1']).toBe(false);
  });

  test('reconnected 置连接位并清空错误与重连态', () => {
    const h = makeHarness();
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'error', errorType: 'auth_failed' }));
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'reconnected' }));
    expect(h.state().deviceConnected['device-1']).toBe(true);
    expect(h.state().deviceErrors['device-1']).toBeUndefined();
    expect(h.state().deviceReconnecting['device-1']).toBeUndefined();
  });

  test('tmux-missing 无副作用', () => {
    const h = makeHarness();
    handleDeviceEvent(h.ctx, deviceEvent({ type: 'tmux-missing', message: 'no tmux' }));
    expect(h.state().deviceErrors['device-1']).toBeUndefined();
    expect(h.state().deviceConnected['device-1']).toBeUndefined();
    expect(h.errors).toHaveLength(0);
  });
});
