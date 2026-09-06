// 入口机上「其它节点事件」的 toast 判据与订阅接线。

import { describe, expect, test } from 'bun:test';
import type { WebhookEvent } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const {
  forwardedEventPath,
  forwardedOrigin,
  formatForwardedEventToast,
  shouldToastForwardedEvent,
  subscribeEntryNotifyToasts,
} = await import('./entry-notify-toasts');

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
    routeNodeId: ENTRY,
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

  test('来源正是当前路由 node：那台机器的运行时已经弹过，不弹两遍', () => {
    expect(shouldToastForwardedEvent(ctx({ routeNodeId: NODE_B }))).toBe(false);
    expect(shouldToastForwardedEvent(ctx({ routeNodeId: NODE_C }))).toBe(true);
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

describe('订阅接线', () => {
  test('NOTIFY_EVENT 里的远端事件弹一条；本机自产的不弹', () => {
    const toasts: Toast[] = [];
    const { runtime, emit } = fakeRuntime(toasts);
    const stop = subscribeEntryNotifyToasts(runtime as never, {
      routeNodeId: () => ENTRY,
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
      routeNodeId: () => ENTRY,
      entryNodeId: () => ENTRY,
      t,
    });
    emit({ kind: wsBorsh.KIND_WATCH_EVENT, payload: new Uint8Array(4) });
    expect(toasts).toHaveLength(0);
  });
});
