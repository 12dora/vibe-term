// mesh 节点列表的纯函数：指纹、NODE_EVENT 投影、排序、hub 合并与 hub 候选顺序；
// 以及宿主级唯一那条轮询回路（单例引用计数 + 后台暂停）。

import { describe, expect, test } from 'bun:test';
import type { AuthApi, AuthRequiredDetail, MeshNode } from '@tmex/api-client/auth/index';
import { wsBorsh } from '@tmex/shared';
import { bytesToHex, encodeBase64url, sha256 } from '@tmex/shared/auth';
import type { HubNodeRow } from './hub-api';
import { type NodeEventPayload, decodeMeshFrame } from './mesh-events';
import {
  MESH_NODES_POLL_MS,
  MESH_NODES_STALE_MS,
  type MeshEventSubscriber,
  acquireMeshNodesPolling,
  ensureFreshMeshNodes,
  findHubNodeId,
  getMeshNodesState,
  mergeNodes,
  patchNodesWithEvent,
  publicKeyFingerprint,
  refreshMeshNodes,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
  sortNodes,
  toRuntimeNodeId,
} from './mesh-nodes';

function node(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: encodeBase64url(new Uint8Array(32).fill(1)),
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

describe('publicKeyFingerprint', () => {
  test('sha256(pk) 的前 16 个 hex 字符', () => {
    const pk = new Uint8Array(32).fill(7);
    const expected = bytesToHex(sha256(pk)).slice(0, 16);
    expect(publicKeyFingerprint(encodeBase64url(pk))).toBe(expected);
    expect(publicKeyFingerprint(encodeBase64url(pk))).toHaveLength(16);
  });

  test('畸形 base64url 返回空串而不是抛异常', () => {
    expect(publicKeyFingerprint('!!!not-base64!!!')).toBe('');
  });
});

describe('toRuntimeNodeId', () => {
  test('entry 自身退化为 self，其余原样', () => {
    expect(toRuntimeNodeId('n1', 'n1')).toBe('self');
    expect(toRuntimeNodeId('n2', 'n1')).toBe('n2');
    expect(toRuntimeNodeId('n2', null)).toBe('n2');
  });
});

describe('patchNodesWithEvent', () => {
  const nodes = [node({ id: 'a', online: false, reach: null }), node({ id: 'b' })];

  test('online 事件更新在线态、到达路径与 inventory 版本', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'relay',
      inventory: { version: '9.9.9' },
    });
    expect(next[0].online).toBe(true);
    expect(next[0].reach).toBe('relay');
    expect(next[0].version).toBe('9.9.9');
    expect(next[1]).toBe(nodes[1]);
  });

  test('offline 事件清掉到达路径', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'b',
      status: 'offline',
      reach: 'lan',
      inventory: null,
    });
    expect(next[1].online).toBe(false);
    expect(next[1].reach).toBeNull();
  });

  test('revoked 事件把该 node 从列表里摘掉', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'revoked',
      reach: null,
      inventory: null,
    });
    expect(next.map((row) => row.id)).toEqual(['b']);
  });

  test('未知 nodeId 返回原数组引用（不触发重渲染）', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'zzz',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next).toBe(nodes);
  });

  test('online 事件带上 transport 与 rttMs，offline 一并清掉', () => {
    const online = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'wan',
      transport: 'ws-secure',
      rttMs: 42,
      inventory: null,
    });
    expect(online[0].reach).toBe('wan');
    expect(online[0].transport).toBe('ws-secure');
    expect(online[0].rttMs).toBe(42);

    const offline = patchNodesWithEvent(online, {
      nodeId: 'a',
      status: 'offline',
      reach: 'wan',
      transport: 'ws-secure',
      rttMs: 42,
      inventory: null,
    });
    expect(offline[0].reach).toBeNull();
    expect(offline[0].transport).toBeNull();
    expect(offline[0].rttMs).toBeNull();
  });

  test('事件没带 transport / rttMs 时保留列表里已有的值', () => {
    const base = patchNodesWithEvent(nodes, {
      nodeId: 'b',
      status: 'online',
      reach: 'lan',
      transport: 'dc',
      rttMs: 7,
      inventory: null,
    });
    const next = patchNodesWithEvent(base, {
      nodeId: 'b',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next[1].transport).toBe('dc');
    expect(next[1].rttMs).toBe(7);
  });

  const linked = () => [
    node({
      id: 'a',
      reach: 'lan',
      transport: 'ws-secure',
      peerAddress: '10.0.0.7',
      linkSinceAt: 1_700_000_000_000,
      directFailure: { at: 1_699_999_000_000, ws: 'timeout ws://10.0.0.9:39001/peer', dc: null },
    }),
    node({ id: 'b' }),
  ];

  test('同一条链路的事件保留只 REST 下发的现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      transport: 'ws-secure',
      rttMs: 5,
      inventory: null,
    });
    expect(next[0].peerAddress).toBe('10.0.0.7');
    expect(next[0].linkSinceAt).toBe(1_700_000_000_000);
    expect(next[0].directFailure?.ws).toBe('timeout ws://10.0.0.9:39001/peer');
  });

  test('事件没带 transport 时按同一条链路处理，现场照样保留', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      inventory: null,
    });
    expect(next[0].transport).toBe('ws-secure');
    expect(next[0].peerAddress).toBe('10.0.0.7');
    expect(next[0].linkSinceAt).toBe(1_700_000_000_000);
  });

  test('换了承载（ws-secure → relay）就把旧链路的现场清掉', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'relay',
      transport: 'relay',
      inventory: null,
    });
    expect(next[0].transport).toBe('relay');
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('承载没变但到达路径变了同样清掉旧现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'online',
      reach: 'wan',
      transport: 'ws-secure',
      inventory: null,
    });
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('offline 事件清掉链路现场', () => {
    const next = patchNodesWithEvent(linked(), {
      nodeId: 'a',
      status: 'offline',
      reach: null,
      inventory: null,
    });
    expect(next[0].peerAddress).toBeNull();
    expect(next[0].linkSinceAt).toBeNull();
    expect(next[0].directFailure).toBeNull();
  });

  test('NODE_EVENT 更新 version / direct_capable / name', () => {
    const next = patchNodesWithEvent(nodes, {
      nodeId: 'a',
      status: 'online',
      reach: 'lan',
      inventory: null,
      version: '2.3.4',
      direct_capable: true,
      name: 'studio',
    });
    expect(next[0].version).toBe('2.3.4');
    expect(next[0].direct_capable).toBe(true);
    expect(next[0].name).toBe('studio');
    expect(next[1]).toBe(nodes[1]);
  });

  test('legacy 四字段 NODE_EVENT 不覆盖已有 direct_capable:true', () => {
    const body = wsBorsh.encodePayload(wsBorsh.schema.NodeEventLegacySchema, {
      nodeId: 'a',
      status: wsBorsh.NODE_EVENT_STATUS_ONLINE,
      reach: 'lan',
      inventory: null,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_NODE_EVENT, body, 1);
    const event = decodeMeshFrame(frame);
    expect(event?.kind).toBe('node-event');
    if (event?.kind !== 'node-event') throw new Error('expected node-event');
    const online = node({ id: 'a', name: 'alpha', direct_capable: true });
    const next = patchNodesWithEvent([online], event.payload);
    expect(next[0]?.direct_capable).toBe(true);
  });
});

describe('sortNodes', () => {
  test('entry 自身第一，其次在线，再按名称', () => {
    const rows = [
      node({ id: 'c', name: 'charlie', online: false }),
      node({ id: 'b', name: 'bravo' }),
      node({ id: 'a', name: 'alpha' }),
    ];
    expect(sortNodes(rows, 'c').map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(sortNodes(rows, null).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeNodes', () => {
  const meshNodes = [
    node({ id: 'entry', name: 'entry', loggedIn: true }),
    node({ id: '远端', name: 'studio', online: false, reach: null, loggedIn: false }),
  ];
  const hubNodes: HubNodeRow[] = [
    {
      id: 'entry',
      name: 'hub-machine',
      status: 'active',
      online: true,
      version: '1.2.3',
      last_seen_at: 1700000000000,
      direct_capable: true,
    },
  ];

  test('mesh 是成员集权威，hub 补充心跳/状态/名称', () => {
    const rows = mergeNodes(meshNodes, hubNodes, { entryNodeId: 'entry', hubNodeId: 'entry' });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('entry');
    expect(rows[0].runtimeNodeId).toBe('self');
    expect(rows[0].isSelf).toBe(true);
    expect(rows[0].isHub).toBe(true);
    expect(rows[0].name).toBe('hub-machine');
    expect(rows[0].lastSeenAt).toBe(1700000000000);
    expect(rows[0].status).toBe('active');
    expect(rows[0].directCapable).toBe(true);
    expect(rows[0].fingerprint).toHaveLength(16);
  });

  test('hub 不可达时补充字段为 null，mesh 字段照常', () => {
    const rows = mergeNodes(meshNodes, null, { entryNodeId: 'entry', hubNodeId: null });
    expect(rows[1].id).toBe('远端');
    expect(rows[1].runtimeNodeId).toBe('远端');
    expect(rows[1].lastSeenAt).toBeNull();
    expect(rows[1].status).toBeNull();
    expect(rows[1].isHub).toBe(false);
    expect(rows[1].online).toBe(false);
    expect(rows[1].reach).toBeNull();
  });

  test('transport 与 rttMs 原样带进行；未知取值归一成 null', () => {
    // 线上可能来自更新的 node，出现前端还不认识的枚举值，一律归一成 null 而不是照单全收
    const weird = {
      ...node({ id: 'weird' }),
      reach: 'nonsense',
      transport: 'quic',
      rttMs: -1,
    } as unknown as MeshNode;
    const rows = mergeNodes(
      [
        node({ id: 'entry', reach: 'wan', transport: 'ws-secure', rttMs: 12.4 }),
        node({ id: 'dc', reach: 'lan', transport: 'dc', rttMs: null }),
        weird,
      ],
      null,
      { entryNodeId: 'entry', hubNodeId: null }
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('entry')).toMatchObject({ reach: 'wan', transport: 'ws-secure', rttMs: 12.4 });
    expect(byId.get('dc')).toMatchObject({ reach: 'lan', transport: 'dc', rttMs: null });
    expect(byId.get('weird')).toMatchObject({ reach: null, transport: null, rttMs: null });
  });

  test('mesh 行不带 transport / rttMs 时补 null', () => {
    const rows = mergeNodes([node({ id: 'legacy' })], null, {
      entryNodeId: null,
      hubNodeId: null,
    });
    expect(rows[0].transport).toBeNull();
    expect(rows[0].rttMs).toBeNull();
  });

  test('hub 列表里多出来的 node 不会凭空出现在表里', () => {
    const rows = mergeNodes(meshNodes, [...hubNodes, { ...hubNodes[0], id: 'ghost' }], {
      entryNodeId: 'entry',
      hubNodeId: 'entry',
    });
    expect(rows.map((row) => row.id)).toEqual(['entry', '远端']);
  });
});

describe('findHubNodeId', () => {
  test('只认 mesh 列表里的 isHub 标志位', () => {
    const rows = [node({ id: 'a' }), node({ id: 'b', isHub: true }), node({ id: 'entry' })];
    expect(findHubNodeId(rows, null)).toBe('b');
  });

  test('列表还没到时用 /api/auth/mode 的 hubNodeId', () => {
    expect(findHubNodeId([], 'hub-1')).toBe('hub-1');
  });

  test('inventory 里的 hub 角色不再被当成标志位（启发式已删除）', () => {
    const rows = [node({ id: 'h', inventory: { roles: 'hub,node' } }), node({ id: 'entry' })];
    expect(findHubNodeId(rows, null)).toBeNull();
  });

  test('isHub 优先于 mode 的 hubNodeId', () => {
    const rows = [node({ id: 'b', isHub: true })];
    expect(findHubNodeId(rows, 'stale')).toBe('b');
  });
});

describe('mergeNodes 的 isHub', () => {
  test('mesh 行自带 isHub 时不依赖上下文的 hubNodeId', () => {
    const rows = mergeNodes([node({ id: 'x', isHub: true })], null, {
      entryNodeId: null,
      hubNodeId: null,
    });
    expect(rows[0].isHub).toBe(true);
  });
});

const INTERVAL_MS = MESH_NODES_POLL_MS;

/** 假的事件源：连接状态与 NODE_EVENT 全由用例驱动。 */
function fakeEvents() {
  const statusListeners = new Set<() => void>();
  const nodeListeners = new Set<(event: NodeEventPayload) => void>();
  const source: MeshEventSubscriber = {
    connected: false,
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onNodeEvent: (listener) => {
      nodeListeners.add(listener);
      return () => {
        nodeListeners.delete(listener);
      };
    },
  };
  const mutable = source as { connected: boolean };
  return {
    source,
    setConnected(next: boolean) {
      mutable.connected = next;
      for (const listener of statusListeners) listener();
    },
    emit(event: NodeEventPayload) {
      for (const listener of nodeListeners) listener(event);
    },
  };
}

/** 一条被完全接管的轮询回路：定时器、可见性、时钟、刷新动作都由用例驱动。 */
function pollingHarness(overrides: { throttleMs?: number } = {}) {
  const events = fakeEvents();
  const authListeners = new Set<(detail: AuthRequiredDetail) => void>();
  const state = {
    refreshes: 0,
    scheduled: 0,
    intervalMs: 0,
    tick: null as (() => void) | null,
    delays: [] as { fn: () => void; ms: number }[],
    onVisibilityChange: null as (() => void) | null,
    hidden: false,
    now: 1_000_000,
  };
  const options = {
    // 兜底间隔不显式传，用例据此断言默认值就是 5 分钟
    throttleMs: overrides.throttleMs ?? 0,
    events: events.source,
    authRequired: (listener: (detail: AuthRequiredDetail) => void) => {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    },
    refresh: (_api: AuthApi) => {
      state.refreshes += 1;
    },
    schedule: (fn: () => void, ms: number) => {
      state.scheduled += 1;
      state.intervalMs = ms;
      state.tick = fn;
      return () => {
        state.tick = null;
      };
    },
    delay: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      state.delays.push(entry);
      return () => {
        state.delays = state.delays.filter((item) => item !== entry);
      };
    },
    visibility: {
      hidden: () => state.hidden,
      subscribe: (listener: () => void) => {
        state.onVisibilityChange = listener;
        return () => {
          state.onVisibilityChange = null;
        };
      },
    },
    now: () => state.now,
  };
  const authRequired = {
    get listeners(): number {
      return authListeners.size;
    },
    emit(detail: AuthRequiredDetail) {
      for (const listener of [...authListeners]) listener(detail);
    },
  };
  return { state, options, events, authRequired };
}

const onlineEvent = (nodeId: string): NodeEventPayload => ({
  nodeId,
  status: 'online',
  reach: 'lan',
  inventory: null,
});

describe('acquireMeshNodesPolling', () => {
  test('两个消费方共用同一条回路：只装一个定时器，兜底间隔 5 分钟，最后一个归还才停', () => {
    const { state, options } = pollingHarness();
    const first = acquireMeshNodesPolling(options);
    // 第二个消费方的接线整个不生效（首个取用方定了这一轮回路），也不额外拉一次
    const secondHarness = pollingHarness();
    const second = acquireMeshNodesPolling(secondHarness.options);

    expect(state.scheduled).toBe(1);
    expect(state.intervalMs).toBe(300_000);
    expect(MESH_NODES_POLL_MS).toBe(300_000);
    expect(state.refreshes).toBe(1);
    expect(secondHarness.state.scheduled).toBe(0);
    expect(secondHarness.state.refreshes).toBe(0);

    first();
    expect(state.tick).not.toBeNull();
    state.tick?.();
    expect(state.refreshes).toBe(2);

    second();
    expect(state.tick).toBeNull();
    // 归还是幂等的：重复调用不会把下一条回路误停
    second();
    const next = acquireMeshNodesPolling(options);
    expect(state.scheduled).toBe(2);
    next();
  });

  test('页面隐藏期间跳过这一拍', () => {
    const { state, options } = pollingHarness();
    const release = acquireMeshNodesPolling(options);

    state.hidden = true;
    state.tick?.();
    state.tick?.();
    expect(state.refreshes).toBe(1);

    state.hidden = false;
    state.tick?.();
    expect(state.refreshes).toBe(2);
    release();
  });

  test('重新可见时：距上次刷新超过 30 秒的过期阈值就立刻补一次，否则等下一拍', () => {
    const { state, options } = pollingHarness();
    setMeshNodesStateForTest({ loadedAt: state.now });
    const release = acquireMeshNodesPolling(options);

    // 刚刷新过：回到前台不重复拉
    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(1);

    // 后台待了不到 30 秒：仍然不补拉（兜底间隔已是 5 分钟，阈值是独立的 30 秒）
    state.now += MESH_NODES_STALE_MS - 1;
    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(1);

    // 后台待够 30 秒：回到前台立刻补
    state.now += 1;
    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(2);

    // 仍在后台的 visibilitychange（切走那一次）不触发刷新
    state.hidden = true;
    state.now += INTERVAL_MS;
    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(2);

    release();
    resetMeshNodesStateForTest();
  });

  test('一份数据都还没有时回到前台必定补拉', () => {
    resetMeshNodesStateForTest();
    const { state, options } = pollingHarness();
    const release = acquireMeshNodesPolling(options);

    state.onVisibilityChange?.();
    expect(state.refreshes).toBe(2);
    release();
  });

  test('/mesh/ws 连上与重连各补一次；断开本身不补', () => {
    resetMeshNodesStateForTest();
    const { state, options, events } = pollingHarness();
    const release = acquireMeshNodesPolling(options);
    expect(state.refreshes).toBe(1);

    events.setConnected(true);
    expect(state.refreshes).toBe(2);

    // 断流期间不发请求，重连回来才补：断线那段时间的事件已经错过了
    events.setConnected(false);
    expect(state.refreshes).toBe(2);
    events.setConnected(true);
    expect(state.refreshes).toBe(3);

    release();
    // 归还后不再受事件驱动
    events.setConnected(false);
    events.setConnected(true);
    expect(state.refreshes).toBe(3);
  });

  test('列表里没有的 node 的事件触发补拉，已知 node 与 revoked 不触发', () => {
    const { state, options, events } = pollingHarness();
    setMeshNodesStateForTest({ loadedAt: state.now, nodes: [node({ id: 'known' })] });
    const release = acquireMeshNodesPolling(options);
    expect(state.refreshes).toBe(1);

    events.emit(onlineEvent('known'));
    expect(state.refreshes).toBe(1);

    // revoked 由 patchNodesWithEvent 就地摘行，不必回源
    events.emit({ nodeId: 'stranger', status: 'revoked', reach: null, inventory: null });
    expect(state.refreshes).toBe(1);

    // 事件只改已知行，新成员必须靠 REST 才进得来
    events.emit(onlineEvent('stranger'));
    expect(state.refreshes).toBe(2);

    release();
    resetMeshNodesStateForTest();
  });

  test('REST 始终不返回的陌生 node 不会每次上下线都补拉，兜底一拍后才放行重试', () => {
    const { state, options, events } = pollingHarness();
    setMeshNodesStateForTest({ loadedAt: state.now, nodes: [node({ id: 'known' })] });
    const release = acquireMeshNodesPolling(options);

    events.emit(onlineEvent('ghost'));
    expect(state.refreshes).toBe(2);
    // 刷新回来它仍然不在列表里（例如公钥无效被投影丢掉）：不再为同一个 id 反复回源
    events.emit(onlineEvent('ghost'));
    events.emit(onlineEvent('ghost'));
    expect(state.refreshes).toBe(2);

    state.tick?.();
    expect(state.refreshes).toBe(3);
    events.emit(onlineEvent('ghost'));
    expect(state.refreshes).toBe(4);

    release();
    resetMeshNodesStateForTest();
  });

  test('首拉还没回来时事件不抢跑（loadedAt 为 null）', () => {
    resetMeshNodesStateForTest();
    const { state, options, events } = pollingHarness();
    const release = acquireMeshNodesPolling(options);

    events.emit(onlineEvent('stranger'));
    expect(state.refreshes).toBe(1);
    release();
  });

  test('单个 node 的 401 只回源、不就地翻 loggedIn；同一 node 每拍一次；全局 401 不管', () => {
    const { state, options, authRequired } = pollingHarness();
    setMeshNodesStateForTest({
      loadedAt: state.now,
      entryNodeId: 'entry',
      nodes: [node({ id: 'entry', loggedIn: true }), node({ id: 'remote', loggedIn: true })],
    });
    const release = acquireMeshNodesPolling(options);
    expect(state.refreshes).toBe(1);

    // 转发路径会产生会话仍有效的 401，登录态只能由 REST 决定，这里不能抽掉节点子树
    authRequired.emit({ nodeId: 'remote', scope: 'node', path: '/n/remote/api/x' });
    expect(getMeshNodesState().nodes.find((row) => row.id === 'remote')?.loggedIn).toBe(true);
    expect(state.refreshes).toBe(2);

    // 同一 node 持续 401 不再回源
    authRequired.emit({ nodeId: 'remote', scope: 'node', path: '/n/remote/api/y' });
    expect(state.refreshes).toBe(2);

    // 全局 401 由拦截器跳登录页，这里既不改行也不补拉
    authRequired.emit({ nodeId: 'self', scope: 'global', path: '/api/x' });
    expect(getMeshNodesState().nodes.find((row) => row.id === 'entry')?.loggedIn).toBe(true);
    expect(state.refreshes).toBe(2);

    // 另一台 node 的首次 401 仍会回源
    authRequired.emit({ nodeId: 'self', scope: 'node', path: '/api/x' });
    expect(state.refreshes).toBe(3);

    // 兜底拍清空去重集合，之后同一 node 的 401 可再次回源
    state.tick?.();
    expect(state.refreshes).toBe(4);
    authRequired.emit({ nodeId: 'remote', scope: 'node', path: '/n/remote/api/z' });
    expect(state.refreshes).toBe(5);

    expect(authRequired.listeners).toBe(1);
    release();
    expect(authRequired.listeners).toBe(0);
    resetMeshNodesStateForTest();
  });

  test('一串事件在节流窗口内只换来一次补拉', () => {
    const { state, options, events } = pollingHarness({ throttleMs: 2_000 });
    setMeshNodesStateForTest({ loadedAt: state.now, nodes: [node({ id: 'known' })] });
    const release = acquireMeshNodesPolling(options);
    expect(state.refreshes).toBe(1);

    for (const id of ['s1', 's2', 's3', 's4', 's5']) events.emit(onlineEvent(id));
    events.setConnected(true);
    // 首拉刚发生，窗口内的这一串统统折叠成一次待发的补拉
    expect(state.refreshes).toBe(1);
    expect(state.delays).toHaveLength(1);
    expect(state.delays[0].ms).toBe(2_000);

    state.delays[0].fn();
    expect(state.refreshes).toBe(2);

    // 窗口过去之后的事件立刻补拉
    state.now += 2_000;
    events.emit(onlineEvent('s6'));
    expect(state.refreshes).toBe(3);

    release();
    resetMeshNodesStateForTest();
  });
});

/** 一个可由用例决定何时落地的 `listNodes`。 */
function deferredApi() {
  const pending: ((rows: MeshNode[]) => void)[] = [];
  const api = {
    listNodes: () =>
      new Promise<MeshNode[]>((resolve) => {
        pending.push(resolve);
      }),
  } as unknown as AuthApi;
  return { api, pending };
}

describe('ensureFreshMeshNodes', () => {
  test('在途期间触发：等在飞的那次落地后再发一次真实请求，重复触发只合并成一次', async () => {
    resetMeshNodesStateForTest();
    const { api, pending } = deferredApi();

    const first = refreshMeshNodes(api);
    expect(pending).toHaveLength(1);

    // 在途期间的两次触发不能复用这次请求：它可能早于变化就发出去了
    ensureFreshMeshNodes(api);
    ensureFreshMeshNodes(api);
    expect(pending).toHaveLength(1);

    pending[0]([node({ id: 'a' })]);
    await first;
    // 尾随的那一次在第一次落地后补发，且只有一次
    expect(pending).toHaveLength(2);

    pending[1]([node({ id: 'a' }), node({ id: 'b' })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(getMeshNodesState().nodes.map((row) => row.id)).toEqual(['a', 'b']);
    // 尾随请求自己不再排下一次
    expect(pending).toHaveLength(2);
    resetMeshNodesStateForTest();
  });

  test('没有在途请求时立刻发一次', async () => {
    resetMeshNodesStateForTest();
    const { api, pending } = deferredApi();

    ensureFreshMeshNodes(api);
    expect(pending).toHaveLength(1);
    pending[0]([node({ id: 'a' })]);
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    resetMeshNodesStateForTest();
  });

  test('在途请求失败时尾随的那次照发（不能因为一次网络错误就卡住成员集）', async () => {
    resetMeshNodesStateForTest();
    const pending: (() => void)[] = [];
    let calls = 0;
    const api = {
      listNodes: () => {
        calls += 1;
        return new Promise<MeshNode[]>((_resolve, reject) => {
          pending.push(() => reject(new Error('boom')));
        });
      },
    } as unknown as AuthApi;

    const first = refreshMeshNodes(api);
    ensureFreshMeshNodes(api);
    pending[0]();
    await first;
    expect(calls).toBe(2);
    pending[1]();
    await Promise.resolve();
    await Promise.resolve();
    resetMeshNodesStateForTest();
  });
});
