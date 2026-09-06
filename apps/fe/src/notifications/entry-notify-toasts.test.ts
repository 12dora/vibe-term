// 入口机上「其它节点事件」的 toast 判据与订阅接线。

import { beforeEach, describe, expect, test } from 'bun:test';
import { claimToastFor, resetToastDedupeForTest } from '@tmex/notifications';
import type { WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const {
  forwardedEventPath,
  forwardedOrigin,
  forwardedToastIdentity,
  formatForwardedEventToast,
  shouldToastForwardedEvent,
  subscribeEntryNotifyToasts,
} = await import('./entry-notify-toasts');

beforeEach(() => {
  resetToastDedupeForTest();
});

const ENTRY = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);
const NODE_C = 'cc'.repeat(16);

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

function event(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventType: 'terminal_bell',
    timestamp: new Date(0).toISOString(),
    site: { name: 'tmex', url: 'https://tmex.example.com' },
    device: { id: 'd1', name: 'laptop', type: 'local' },
    tmux: { windowId: '@1', paneId: '%2', windowIndex: 0 },
    payload: { nodeId: NODE_B, nodeName: 'laptop' },
    ...overrides,
  } as WebhookEvent;
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'terminal_bell',
    event: event(),
    entryNodeId: ENTRY,
    hostManagedNotifications: false,
    toastEnabled: true,
    ...overrides,
  } as Parameters<typeof shouldToastForwardedEvent>[0];
}

describe('来源判定', () => {
  test('payload 里没有 nodeId 的是本机自产事件', () => {
    expect(forwardedOrigin(event({ payload: {} }))).toBeNull();
    expect(forwardedOrigin(event({ payload: undefined }))).toBeNull();
  });

  test('有 nodeId 就是转发来的；没有名字退回 null 由调用方兜底', () => {
    expect(forwardedOrigin(event())).toEqual({ nodeId: NODE_B, nodeName: 'laptop' });
    expect(forwardedOrigin(event({ payload: { nodeId: NODE_B } }))).toEqual({
      nodeId: NODE_B,
      nodeName: null,
    });
  });
});

describe('是否该弹', () => {
  test('其它节点转发来的：弹', () => {
    expect(shouldToastForwardedEvent(ctx())).toBe(true);
  });

  test('本机自产（无来源）：既有通道已经弹过，不重复', () => {
    expect(shouldToastForwardedEvent(ctx({ event: event({ payload: {} }) }))).toBe(false);
  });

  test('来源就是入口自身：不弹', () => {
    expect(shouldToastForwardedEvent(ctx({ event: event({ payload: { nodeId: ENTRY } }) }))).toBe(
      false
    );
  });

  test('来源是不是当前路由 node 都照弹：重复交给身份去重，不靠路由猜', () => {
    // 浏览器可能压根没订阅那台机器（别的浏览器持着订阅、懒登录门闸没放行），
    // 也可能刚离开那条路由但运行时还在宽限期——两种都不能靠路由排除。
    expect(shouldToastForwardedEvent(ctx({ event: event({ payload: { nodeId: NODE_B } }) }))).toBe(
      true
    );
    expect(shouldToastForwardedEvent(ctx({ event: event({ payload: { nodeId: NODE_C } }) }))).toBe(
      true
    );
  });

  test('agent_* 由发起机上报，不属于转发：不弹', () => {
    expect(shouldToastForwardedEvent(ctx({ eventType: 'agent_turn_finished' }))).toBe(false);
  });

  test('站点关掉浏览器 toast / 宿主接管通知：不弹', () => {
    expect(shouldToastForwardedEvent(ctx({ toastEnabled: false }))).toBe(false);
    expect(shouldToastForwardedEvent(ctx({ hostManagedNotifications: true }))).toBe(false);
  });
});

describe('深链与文案', () => {
  test('带 window/pane：拼到来源节点的 pane 路由', () => {
    const path = forwardedEventPath(event(), { nodeId: NODE_B, nodeName: 'laptop' });
    expect(path).toBe(`/n/${NODE_B}/devices/d1/windows/%401/panes/%252`);
  });

  test('只有设备：退到设备页；没有设备则拼不出', () => {
    expect(forwardedEventPath(event({ tmux: undefined }), { nodeId: NODE_B, nodeName: null })).toBe(
      `/n/${NODE_B}/devices/d1`
    );
    expect(
      forwardedEventPath(event({ device: { id: '-', name: '-', type: 'local' } } as never), {
        nodeId: NODE_B,
        nodeName: null,
      })
    ).toBeNull();
  });

  test('标题取事件类型，正文首行点名来源节点与设备', () => {
    const { title, description } = formatForwardedEventToast(
      'terminal_bell',
      event({ payload: { nodeId: NODE_B, nodeName: 'laptop', body: 'ding' } }),
      { nodeId: NODE_B, nodeName: 'laptop' },
      t
    );
    expect(title).toContain('notification.eventType.terminal_bell');
    expect(description).toContain('notification.mesh.origin');
    expect(description).toContain('laptop');
    expect(description).toContain('ding');
  });
});

interface Toast {
  title: string;
  description?: string;
}

function fakeRuntime(toasts: Toast[]) {
  let handler: ((msg: { kind: number; payload: Uint8Array }) => void) | null = null;
  const runtime = {
    client: {
      onMessage(next: (msg: { kind: number; payload: Uint8Array }) => void) {
        handler = next;
        return () => {
          handler = null;
        };
      },
    },
    features: { hostManagedNotifications: false },
    stores: { site: { getState: () => ({ settings: { enableBrowserNotificationToast: true } }) } },
    notifications: {
      info(title: string, options?: { description?: string }) {
        toasts.push({ title, description: options?.description });
      },
    },
    host: { navigate: () => undefined, closeMobileSidebar: () => undefined },
  };
  return { runtime, emit: (msg: { kind: number; payload: Uint8Array }) => handler?.(msg) };
}

function notifyFrame(eventType: string, payload: WebhookEvent) {
  return {
    kind: wsBorsh.KIND_NOTIFY_EVENT,
    payload: wsBorsh.encodePayload(wsBorsh.schema.EventNotifyS2CSchema, {
      eventType,
      eventJson: JSON.stringify(payload),
      timestamp: 0n,
    }),
  };
}

describe('事件身份', () => {
  test('与来源机直投那一路对齐：node / device / pane / rule 四段', () => {
    expect(
      forwardedToastIdentity(
        'watch_triggered',
        event({
          eventType: 'watch_triggered',
          payload: { nodeId: NODE_B, ruleId: 'r1' },
        }),
        { nodeId: NODE_B, nodeName: null }
      )
    ).toEqual({
      eventType: 'watch_triggered',
      nodeId: NODE_B,
      deviceId: 'd1',
      paneId: '%2',
      ruleId: 'r1',
    });
  });

  test('没有 ruleId 的事件那一段为空', () => {
    expect(
      forwardedToastIdentity('terminal_bell', event(), { nodeId: NODE_B, nodeName: null })
    ).toMatchObject({ ruleId: null });
  });
});

describe('订阅接线', () => {
  test('NOTIFY_EVENT 里的远端事件弹一条；本机自产的不弹', () => {
    const toasts: Toast[] = [];
    const { runtime, emit } = fakeRuntime(toasts);
    const stop = subscribeEntryNotifyToasts(runtime as never, {
      entryNodeId: () => ENTRY,
      t,
    });

    emit(notifyFrame('terminal_bell', event()));
    emit(notifyFrame('terminal_bell', event({ payload: {} })));
    stop();
    emit(notifyFrame('terminal_bell', event()));

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.description).toContain('notification.mesh.origin');
  });

  test('别的 kind 一律不看', () => {
    const toasts: Toast[] = [];
    const { runtime, emit } = fakeRuntime(toasts);
    subscribeEntryNotifyToasts(runtime as never, {
      entryNodeId: () => ENTRY,
      t,
    });
    emit({ kind: wsBorsh.KIND_WATCH_EVENT, payload: new Uint8Array(4) });
    expect(toasts).toHaveLength(0);
  });
});

describe('身份去重', () => {
  function subscribe(toasts: Toast[]) {
    const { runtime, emit } = fakeRuntime(toasts);
    subscribeEntryNotifyToasts(runtime as never, { entryNodeId: () => ENTRY, t });
    return emit;
  }

  const watchEvent = (overrides: Partial<WebhookEvent> = {}) =>
    event({
      eventType: 'watch_triggered',
      payload: { nodeId: NODE_B, nodeName: 'laptop', ruleId: 'r1', message: 'matched' },
      ...overrides,
    });

  test('来源机直投先弹过：转发件同身份，不弹第二条', () => {
    const toasts: Toast[] = [];
    const emit = subscribe(toasts);
    // 直投那一路（`WatchEventsInit`）先认领，键由同一组 id 拼出。
    expect(
      claimToastFor({
        eventType: 'watch_triggered',
        nodeId: NODE_B,
        deviceId: 'd1',
        paneId: '%2',
        ruleId: 'r1',
      })
    ).toBe(true);

    emit(notifyFrame('watch_triggered', watchEvent()));
    expect(toasts).toHaveLength(0);
  });

  test('浏览器没订阅那台设备（直投这一路根本不来）：转发件照弹', () => {
    const toasts: Toast[] = [];
    const emit = subscribe(toasts);
    emit(notifyFrame('watch_triggered', watchEvent()));
    expect(toasts).toHaveLength(1);
  });

  test('转发件重复投递（多条通道）只弹一条', () => {
    const toasts: Toast[] = [];
    const emit = subscribe(toasts);
    emit(notifyFrame('watch_triggered', watchEvent()));
    emit(notifyFrame('watch_triggered', watchEvent()));
    expect(toasts).toHaveLength(1);
  });

  test('不同规则 / 不同来源节点是不同事件，各弹各的', () => {
    const toasts: Toast[] = [];
    const emit = subscribe(toasts);
    emit(notifyFrame('watch_triggered', watchEvent()));
    emit(
      notifyFrame(
        'watch_triggered',
        watchEvent({ payload: { nodeId: NODE_B, ruleId: 'r2', message: 'matched' } })
      )
    );
    emit(
      notifyFrame(
        'watch_triggered',
        watchEvent({ payload: { nodeId: NODE_C, ruleId: 'r1', message: 'matched' } })
      )
    );
    expect(toasts).toHaveLength(3);
  });
});
