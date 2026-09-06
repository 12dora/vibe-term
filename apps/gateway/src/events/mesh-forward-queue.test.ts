import { describe, expect, test } from 'bun:test';
import type { MeshNotificationForwardRequest } from '@tmex/shared';
import {
  MESH_FORWARD_BACKOFF_MS,
  MeshForwardQueue,
  meshForwardBackoffMs,
  meshForwardKey,
} from './mesh-forward-queue';

function body(
  overrides: {
    eventType?: MeshNotificationForwardRequest['eventType'];
    deviceId?: string;
    paneId?: string;
    marker?: string;
  } = {}
): MeshNotificationForwardRequest {
  return {
    eventType: overrides.eventType ?? 'terminal_bell',
    event: {
      site: { name: 'site', url: 'https://a.example' },
      device: { id: overrides.deviceId ?? 'dev-1', name: 'dev', type: 'local' },
      tmux: { paneId: overrides.paneId ?? '%1' },
      payload: { marker: overrides.marker ?? 'x' },
    },
    origin: { nodeId: 'node-a', nodeName: 'A' },
  };
}

describe('meshForwardKey', () => {
  test('按 nodeId:deviceId:paneId:eventType 组键', () => {
    expect(meshForwardKey(body())).toBe('node-a:dev-1:%1:terminal_bell');
  });

  test('缺 pane 用占位符，不与真实 pane 撞键', () => {
    const noPane = body();
    noPane.event.tmux = undefined;
    expect(meshForwardKey(noPane)).toBe('node-a:dev-1:-:terminal_bell');
  });
});

describe('meshForwardBackoffMs', () => {
  test('1/2/4/8 秒后封顶 15 秒', () => {
    expect([0, 1, 2, 3, 4, 5, 99].map(meshForwardBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000,
    ]);
    expect(MESH_FORWARD_BACKOFF_MS.at(-1)).toBe(15_000);
  });
});

describe('MeshForwardQueue', () => {
  test('同身份事件合并，只留最新一条', () => {
    const queue = new MeshForwardQueue();
    queue.push(body({ marker: 'old' }), 0);
    queue.push(body({ marker: 'new' }), 10);
    expect(queue.size).toBe(1);
    expect(queue.shift(20)?.body.event.payload?.marker).toBe('new');
  });

  test('不同 pane 不合并', () => {
    const queue = new MeshForwardQueue();
    queue.push(body({ paneId: '%1' }), 0);
    queue.push(body({ paneId: '%2' }), 0);
    expect(queue.size).toBe(2);
  });

  test('超过 20 条丢最旧并回调', () => {
    const drops: string[] = [];
    const queue = new MeshForwardQueue({
      onDrop: (entry, reason) => drops.push(`${reason}:${entry.key}`),
    });
    for (let i = 0; i < 21; i++) queue.push(body({ paneId: `%${i}` }), i);
    expect(queue.size).toBe(20);
    expect(drops).toEqual(['overflow:node-a:dev-1:%0:terminal_bell']);
    expect(queue.dropped).toBe(1);
    expect(queue.shift(21)?.key).toBe('node-a:dev-1:%1:terminal_bell');
  });

  test('出队时丢弃超过 3 分钟的条目', () => {
    const drops: string[] = [];
    const queue = new MeshForwardQueue({ onDrop: (_entry, reason) => drops.push(reason) });
    queue.push(body({ paneId: '%1' }), 0);
    queue.push(body({ paneId: '%2' }), 179_000);
    const taken = queue.shift(180_000);
    expect(drops).toEqual(['expired']);
    expect(taken?.key).toBe('node-a:dev-1:%2:terminal_bell');
  });

  test('自定义 ttl 生效', () => {
    const queue = new MeshForwardQueue({ ttlMs: 100 });
    queue.push(body(), 0);
    expect(queue.shift(100)).toBeNull();
    expect(queue.dropped).toBe(1);
  });

  test('回插放队首；期间已有同身份的新条目则丢掉回插件', () => {
    const queue = new MeshForwardQueue();
    queue.push(body({ paneId: '%1', marker: 'first' }), 0);
    const entry = queue.shift(1);
    expect(entry).not.toBeNull();
    queue.push(body({ paneId: '%2' }), 2);
    if (entry) queue.unshift(entry);
    expect(queue.size).toBe(2);
    expect(queue.shift(3)?.key).toBe('node-a:dev-1:%1:terminal_bell');

    const again = new MeshForwardQueue();
    again.push(body({ paneId: '%1', marker: 'stale' }), 0);
    const taken = again.shift(1);
    again.push(body({ paneId: '%1', marker: 'fresh' }), 2);
    if (taken) again.unshift(taken);
    expect(again.size).toBe(1);
    expect(again.shift(3)?.body.event.payload?.marker).toBe('fresh');
  });

  test('队列已满时回插丢的是这条最旧的，不能挤掉队尾的新事件', () => {
    const dropped: Array<{ key: string; reason: string }> = [];
    const queue = new MeshForwardQueue({
      max: 2,
      onDrop: (entry, reason) => dropped.push({ key: entry.key, reason }),
    });
    queue.push(body({ paneId: '%1' }), 0);
    const inFlight = queue.shift(0);
    expect(inFlight?.key).toBe('node-a:dev-1:%1:terminal_bell');
    queue.push(body({ paneId: '%2' }), 1);
    queue.push(body({ paneId: '%3' }), 2);
    expect(queue.size).toBe(2);

    if (inFlight) queue.unshift(inFlight);
    expect(queue.size).toBe(2);
    expect(dropped).toEqual([{ key: 'node-a:dev-1:%1:terminal_bell', reason: 'overflow' }]);
    expect(queue.dropped).toBe(1);
    expect([queue.shift(3)?.key, queue.shift(3)?.key]).toEqual([
      'node-a:dev-1:%2:terminal_bell',
      'node-a:dev-1:%3:terminal_bell',
    ]);
  });
});
