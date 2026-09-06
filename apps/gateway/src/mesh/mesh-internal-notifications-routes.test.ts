import { beforeEach, describe, expect, test } from 'bun:test';
import type { EventType, MeshNotificationForwardRequest, WebhookEvent } from '@tmex/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE } from '@tmex/shared';
import { dispatchRoutes } from '../api/route';
import {
  type MeshInternalNotificationDeps,
  createMeshInternalNotificationRoutes,
  resetMeshNotificationRateLimit,
} from './mesh-internal-notifications-routes';
import { setMeshNotificationBridge } from './notification-mesh-bridge';
import { X_TMEX_MESH_PEER } from './peer-request-marker';

type Received = { eventType: EventType; event: Omit<WebhookEvent, 'eventType' | 'timestamp'> };

function forwardBody(overrides: Partial<MeshNotificationForwardRequest> = {}) {
  const base: MeshNotificationForwardRequest = {
    eventType: 'terminal_bell',
    event: {
      site: { name: '源站', url: 'https://origin.example' },
      device: { id: 'dev-1', name: '开发机', type: 'ssh', host: 'h' },
      tmux: { paneId: '%3', windowId: '@1', windowIndex: 2, paneTitle: 'vim' },
      payload: { source: 'osc9' },
    },
    origin: { nodeId: 'node-b', nodeName: 'B 机' },
  };
  return { ...base, ...overrides };
}

function makeDeps(overrides: Partial<MeshInternalNotificationDeps> = {}) {
  const received: Received[] = [];
  const deps: MeshInternalNotificationDeps = {
    sinkEnabled: () => true,
    knownNode: () => true,
    nodeName: (nodeId) => (nodeId === 'node-b' ? 'B 机' : null),
    notify: async (eventType, event) => {
      received.push({ eventType, event });
    },
    site: () => ({ name: '汇聚机', url: 'https://sink.example' }),
    now: () => 1_000,
    ...overrides,
  };
  return { deps, received };
}

function request(body: unknown, marker: string | null = 'node-b'): Request {
  return new Request(`http://localhost${MESH_INTERNAL_NOTIFICATION_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(marker ? { [X_TMEX_MESH_PEER]: marker } : {}),
    },
    body: JSON.stringify(body),
  });
}

function call(deps: MeshInternalNotificationDeps, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const res = dispatchRoutes(req, path, createMeshInternalNotificationRoutes(deps), { path });
  if (!res) throw new Error('route not matched');
  return Promise.resolve(res);
}

describe('mesh-internal notifications route', () => {
  beforeEach(() => {
    resetMeshNotificationRateLimit();
  });

  test('本机开关关着时 404（对端据此丢弃）', async () => {
    const { deps, received } = makeDeps({ sinkEnabled: () => false });
    const res = await call(deps, request(forwardBody()));
    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  test('没有对端标记一律 403', async () => {
    const { deps } = makeDeps();
    const res = await call(deps, request(forwardBody(), null));
    expect(res.status).toBe(403);
  });

  test('来源不是本机认识的 mesh 节点则 403', async () => {
    const { deps } = makeDeps({ knownNode: () => false });
    const res = await call(deps, request(forwardBody()));
    expect(res.status).toBe(403);
  });

  test('origin.nodeId 与对端标记不一致时按非法请求拒绝', async () => {
    const { deps } = makeDeps();
    const body = forwardBody({ origin: { nodeId: 'node-c', nodeName: 'C' } });
    const res = await call(deps, request(body));
    expect(res.status).toBe(400);
  });

  test('未知 eventType / 缺设备一律 400', async () => {
    const { deps } = makeDeps();
    const bad = await call(deps, request({ ...forwardBody(), eventType: 'nope' }));
    expect(bad.status).toBe(400);
    const noDevice = forwardBody();
    noDevice.event = { ...noDevice.event, device: { id: '', name: '', type: 'local' } };
    expect((await call(deps, request(noDevice))).status).toBe(400);
  });

  test('落地时用本机站点信息并把来源节点写进 payload', async () => {
    const { deps, received } = makeDeps();
    const res = await call(deps, request(forwardBody()));
    expect(res.status).toBe(202);
    expect(received).toHaveLength(1);
    const entry = received[0];
    expect(entry.eventType).toBe('terminal_bell');
    expect(entry.event.site).toEqual({ name: '汇聚机', url: 'https://sink.example' });
    expect(entry.event.device).toEqual({ id: 'dev-1', name: '开发机', type: 'ssh', host: 'h' });
    expect(entry.event.tmux).toEqual({
      paneId: '%3',
      windowId: '@1',
      windowIndex: 2,
      paneTitle: 'vim',
    });
    expect(entry.event.payload).toEqual({
      source: 'osc9',
      nodeId: 'node-b',
      nodeName: 'B 机',
    });
  });

  test('payload 里伪造的 nodeId 会被对端标记覆盖', async () => {
    const { deps, received } = makeDeps();
    const body = forwardBody();
    body.event = { ...body.event, payload: { nodeId: 'node-evil', nodeName: 'evil' } };
    await call(deps, request(body));
    expect(received[0]?.event.payload).toEqual({ nodeId: 'node-b', nodeName: 'B 机' });
  });

  test('每来源每分钟 60 条，超出回 429', async () => {
    // TokenBucket 以 lastMs===0 表示「尚未起表」，测试时钟从非零开始才能走到补充逻辑。
    let now = 1_000;
    const { deps, received } = makeDeps({ now: () => now });
    for (let i = 0; i < 60; i++) {
      expect((await call(deps, request(forwardBody()))).status).toBe(202);
    }
    expect((await call(deps, request(forwardBody()))).status).toBe(429);
    expect(received).toHaveLength(60);
    now = 61_000;
    expect((await call(deps, request(forwardBody()))).status).toBe(202);
  });

  test('限流按来源节点分桶', async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 60; i++) await call(deps, request(forwardBody()));
    expect((await call(deps, request(forwardBody()))).status).toBe(429);
    const other = forwardBody({ origin: { nodeId: 'node-c', nodeName: 'C' } });
    expect((await call(deps, request(other, 'node-c'))).status).toBe(202);
  });

  test('别的来源把桶表撑满也不会让已打满的来源重新放行', async () => {
    let now = 1_000;
    const { deps } = makeDeps({ now: () => now, nodeName: () => null });
    for (let i = 0; i < 60; i++) await call(deps, request(forwardBody()));
    expect((await call(deps, request(forwardBody()))).status).toBe(429);
    // 同一时刻涌入 64 个新来源：旧实现会 clear() 整张表，把 node-b 的额度也还回去。
    for (let i = 0; i < 64; i++) {
      const id = `node-x${i}`;
      const other = forwardBody({ origin: { nodeId: id, nodeName: id } });
      expect((await call(deps, request(other, id))).status).toBe(202);
    }
    expect((await call(deps, request(forwardBody()))).status).toBe(429);
    now = 61_000;
    expect((await call(deps, request(forwardBody()))).status).toBe(202);
  });

  test('body 里伪造的 origin.nodeName 无效，显示名由本机元数据决定', async () => {
    const { deps, received } = makeDeps({
      nodeName: (nodeId) => (nodeId === 'node-b' ? '可信 B' : null),
    });
    const body = forwardBody({ origin: { nodeId: 'node-b', nodeName: '<b>伪造名</b>' } });
    expect((await call(deps, request(body))).status).toBe(202);
    expect(received[0]?.event.payload).toEqual({
      source: 'osc9',
      nodeId: 'node-b',
      nodeName: '可信 B',
    });
  });

  test('本机查不到显示名时回落到节点 id', async () => {
    const { deps, received } = makeDeps({ nodeName: () => null });
    await call(deps, request(forwardBody({ origin: { nodeId: 'node-b', nodeName: '伪造' } })));
    expect(received[0]?.event.payload).toMatchObject({ nodeId: 'node-b', nodeName: 'node-b' });
  });

  test('本机渠道扇出慢不拖住发送方：先回 202 再扇出', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: string[] = [];
    const { deps } = makeDeps({
      notify: async (eventType) => {
        await gate;
        done.push(eventType);
      },
    });
    const res = await call(deps, request(forwardBody()));
    expect(res.status).toBe(202);
    expect(done).toEqual([]);
    release();
    await gate;
    await Promise.resolve();
    expect(done).toEqual(['terminal_bell']);
  });
});

describe('默认判据：签名声明 + 本机开关', () => {
  function installBridge(selfSinkEnabled: boolean): void {
    setMeshNotificationBridge({
      selfNodeId: () => 'node-a',
      selfName: () => 'A 机',
      selfSinkEnabled: () => selfSinkEnabled,
      listSinks: () => [],
      deliver: async () => new Response('{}'),
    });
  }

  function callDefault(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const res = dispatchRoutes(req, path, createMeshInternalNotificationRoutes(), { path });
    if (!res) throw new Error('route not matched');
    return Promise.resolve(res);
  }

  test('桥说本机不是汇聚机（没签声明或开关关着）时 404', async () => {
    installBridge(false);
    expect((await callDefault(request(forwardBody()))).status).toBe(404);
    setMeshNotificationBridge(null);
  });

  test('没有 mesh 桥时同样 404', async () => {
    setMeshNotificationBridge(null);
    expect((await callDefault(request(forwardBody()))).status).toBe(404);
  });

  test('声明与开关都成立时才继续走对端标记校验', async () => {
    installBridge(true);
    // 对端标记缺失 → 403，说明已经越过了 404 那一关。
    expect((await callDefault(request(forwardBody(), null))).status).toBe(403);
    setMeshNotificationBridge(null);
  });
});
