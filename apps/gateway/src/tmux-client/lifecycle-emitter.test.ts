import { describe, expect, test } from 'bun:test';
import type { Device, SiteSettings, TmuxWindow } from '@tmex/shared';
import { ConnectionLifecycleEmitter } from './lifecycle-emitter';

function makeDevice(): Device {
  return {
    id: 'd1',
    name: 'dev',
    type: 'local',
    session: 'tmex-le',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeSettings(): SiteSettings {
  return {
    siteName: 'tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 6,
    notificationThrottleSeconds: 3,
    enableBrowserNotificationToast: true,
    enableNotificationPush: true,
    enableBellPush: true,
    enableBellSound: true,
    sshReconnectMaxRetries: 2,
    sshReconnectDelaySeconds: 1,
    language: 'zh_CN',
    theme: 'dark',
    disabledNotificationChannels: [],
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

function makeWindow(id: string, paneIds: string[]): TmuxWindow {
  return {
    id,
    index: 0,
    name: `win-${id}`,
    active: true,
    panes: paneIds.map((paneId, index) => ({
      id: paneId,
      windowId: id,
      index,
      active: index === 0,
      width: 80,
      height: 24,
      title: `t-${paneId}`,
      currentCommand: 'bash',
    })),
  };
}

function makeEmitter(options?: {
  emittable?: boolean;
  windows?: Map<string, TmuxWindow>;
  settingsProvider?: () => SiteSettings;
  notifyEvent?: ((eventType: string, event: unknown) => void) | null;
}) {
  const events: Array<{ eventType: string; event: any }> = [];
  const emitter = new ConnectionLifecycleEmitter({
    getDevice: () => makeDevice(),
    getSessionName: () => 'tmex-le',
    isEmittable: () => options?.emittable ?? true,
    getSnapshotWindows: () => options?.windows ?? new Map(),
    settingsProvider: options?.settingsProvider ?? makeSettings,
    notifyEvent:
      options?.notifyEvent === null
        ? undefined
        : (options?.notifyEvent ??
          ((eventType, event) => {
            events.push({ eventType, event: event as any });
          })),
  });
  return { emitter, events };
}

describe('ConnectionLifecycleEmitter', () => {
  test('emit builds full event shape from context', () => {
    const { emitter, events } = makeEmitter();
    emitter.emit('session_created', { sessionName: 'tmex-le' });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('session_created');
    expect(events[0].event.site.name).toBe('tmex');
    expect(events[0].event.device.id).toBe('d1');
    expect(events[0].event.tmux.sessionName).toBe('tmex-le');
  });

  test('emit is a no-op without notifyEvent wiring', () => {
    const { emitter } = makeEmitter({ notifyEvent: null });
    expect(() => emitter.emit('session_created', { sessionName: 'x' })).not.toThrow();
  });

  // 发射是旁路观测：settings 读取失败或事件回调抛错都不允许打断调用方控制流
  //（session gone 路径的 shutdown 必须继续执行）。
  test('settings provider failure is swallowed', () => {
    const { emitter, events } = makeEmitter({
      settingsProvider: () => {
        throw new Error('db closed');
      },
    });
    expect(() => emitter.notifySessionClosed('gone')).not.toThrow();
    expect(events).toHaveLength(0);
    // once 守卫在失败时同样消耗——同一连接不重试（连接随即 shutdown）
    expect(emitter.sessionClosedEmitted).toBe(true);
  });

  test('notifyEvent callback failure is swallowed', () => {
    const { emitter } = makeEmitter({
      notifyEvent: () => {
        throw new Error('emitter exploded');
      },
    });
    expect(() => emitter.notifySessionCreated()).not.toThrow();
  });

  test('notifySessionClosed emits once and reset() re-arms it', () => {
    const { emitter, events } = makeEmitter();
    emitter.notifySessionClosed('line one\nline two');
    emitter.notifySessionClosed('again');
    expect(events).toHaveLength(1);
    expect(events[0].event.payload.message).toBe('line one');
    expect(emitter.sessionClosedEmitted).toBe(true);

    emitter.reset();
    expect(emitter.sessionClosedEmitted).toBe(false);
    emitter.notifySessionClosed('after reconnect');
    expect(events).toHaveLength(2);
  });

  test('emitSnapshotClosures respects guards (empty prev / empty next / not emittable)', () => {
    const windows = new Map([['@1', makeWindow('@1', ['%1'])]]);
    {
      const { emitter, events } = makeEmitter({ windows });
      emitter.emitSnapshotClosures(new Map());
      expect(events).toHaveLength(0);
    }
    {
      const { emitter, events } = makeEmitter({ windows: new Map() });
      emitter.emitSnapshotClosures(windows);
      expect(events).toHaveLength(0);
    }
    {
      const { emitter, events } = makeEmitter({ windows, emittable: false });
      emitter.emitSnapshotClosures(new Map([['@2', makeWindow('@2', ['%9'])]]));
      expect(events).toHaveLength(0);
    }
  });

  test('emitSnapshotClosures emits window and pane close events with prev metadata', () => {
    const prev = new Map([
      ['@1', makeWindow('@1', ['%1', '%2'])],
      ['@2', makeWindow('@2', ['%3'])],
    ]);
    const next = new Map([['@1', makeWindow('@1', ['%2'])]]);
    const { emitter, events } = makeEmitter({ windows: next });
    emitter.emitSnapshotClosures(prev);
    expect(events.map((e) => e.eventType).sort()).toEqual(['tmux_pane_close', 'tmux_window_close']);
    const windowClose = events.find((e) => e.eventType === 'tmux_window_close');
    const paneClose = events.find((e) => e.eventType === 'tmux_pane_close');
    expect(windowClose?.event.tmux.windowId).toBe('@2');
    expect(paneClose?.event.tmux.paneId).toBe('%1');
    expect(paneClose?.event.tmux.paneTitle).toBe('t-%1');
  });
});
