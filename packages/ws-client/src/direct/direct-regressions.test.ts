// N5 审计复现用例（直连控制器侧）的回归：原用例断言的是旧的错误行为，这里全部取反。
//   A：两次慢 attempt 之后网络恢复，直连应当很快打通，而不是被熔断锁住几分钟；
//   B：自动重试只由熔断限流，`/mesh/ws` 重连不能在冷却中额外拉起请求；
//   C：网络变化 / 页面恢复（`nudge()`）不拆健康的直连；
//   D：primary 断开不算直连失败，反复断开也不会把熔断打开；
//   E：一次 `DIRECT_BUSY` 只记一次账。
// A 用的 node 记录模型按网关侧同轮修复后的契约：pending 记录 30 s 过期、accept 失败即释放、
// 同一条 WS（connectionId）的新授权挤掉旧的 pending 授权。

import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { createGatewayConnection } from '../connection';
import { type FakeSocket, createFakeSocket, helloFrame } from '../test-fakes';
import { directBreakerGate, resetDirectBreakers } from './direct-breaker';
import {
  DirectCarrierController,
  MESH_CONNECTION_PATH,
  NUDGE_COALESCE_MS,
  RTC_AUTHORIZE_PATH,
  RTC_CONFIG_PATH,
} from './direct-carrier-controller';
import {
  FP_NODE_VALUE,
  FakeApiClient,
  FakeConnection,
  FakePeerConnection,
  FakeSignaling,
  ManualClock,
  flush,
  sdpWithFingerprint,
} from './test-fakes';

const NODE = 'node-b';
const NONCE = 'bm9uY2UtMzJieXRlcw';
const GRANT = { nonce: NONCE, fp_node: { algorithm: 'sha-256', value: FP_NODE_VALUE } };

afterEach(() => resetDirectBreakers());

/** 目标 node 的 authorize 记录（网关修复后的契约）。 */
class NodeModel {
  private readonly records = new Map<string, { connectionId: string; exp: number }>();
  readonly granted: string[] = [];
  busy = 0;

  constructor(
    private readonly now: () => number,
    private readonly perSid = 2
  ) {}

  authorize(rtcSession: string, connectionId: string): { status: number; body: unknown } {
    for (const [key, record] of this.records) {
      if (record.exp <= this.now() || record.connectionId === connectionId) {
        this.records.delete(key);
      }
    }
    if (this.records.size >= this.perSid) {
      this.busy += 1;
      return { status: 503, body: { code: 'DIRECT_BUSY', reason: 'capacity', retryAfterMs: 1000 } };
    }
    this.records.set(rtcSession, { connectionId, exp: this.now() + 30_000 });
    this.granted.push(rtcSession);
    return { status: 200, body: GRANT };
  }

  accepted(rtcSession: string): void {
    this.records.delete(rtcSession);
  }
}

function setup(options: { nodeModel?: boolean; retryBaseMs?: number } = {}) {
  const clock = new ManualClock();
  const node = new NodeModel(() => clock.now);
  const api = new FakeApiClient({
    [MESH_CONNECTION_PATH]: { body: { connectionId: 'c1' } },
    [RTC_CONFIG_PATH]: { body: { stun: [], turn: null } },
    [RTC_AUTHORIZE_PATH]: { body: GRANT },
  });
  if (options.nodeModel) {
    const inner = api.fetch.bind(api);
    api.fetch = (path: string, init?: RequestInit) => {
      if (path === RTC_AUTHORIZE_PATH) {
        const body = JSON.parse(String(init?.body)) as { rtcSession: string; connectionId: string };
        api.routes.set(RTC_AUTHORIZE_PATH, node.authorize(body.rtcSession, body.connectionId));
      }
      return inner(path, init);
    };
  }
  const signaling = new FakeSignaling();
  const connection = new FakeConnection();
  const peers: FakePeerConnection[] = [];
  const controller = new DirectCarrierController({
    nodeId: NODE,
    apiClient: api,
    signaling,
    connection,
    rtcFactory: () => {
      const pc = new FakePeerConnection();
      peers.push(pc);
      return pc;
    },
    now: () => clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...(options.retryBaseMs ? { retryBaseMs: options.retryBaseMs } : {}),
  });
  const authorizes = () => api.calls.filter((c) => c.path === RTC_AUTHORIZE_PATH).length;
  async function reachActive(): Promise<void> {
    await flush();
    const rtcSession = controller.rtcSession as string;
    signaling.deliver({
      rtcSession,
      from: 'node',
      to: NODE,
      sdp: JSON.stringify({ type: 'answer', sdp: sdpWithFingerprint(FP_NODE_VALUE, 'answer') }),
      candidate: null,
    });
    await flush();
    peers[peers.length - 1]?.channel.open();
    await flush();
    node.accepted(rtcSession);
    connection.switchTo('direct');
    await flush();
  }
  async function step(ms: number): Promise<void> {
    for (let i = 0; i < ms / 500; i += 1) {
      clock.advance(500);
      await flush(2);
    }
  }
  return {
    clock,
    node,
    api,
    signaling,
    connection,
    peers,
    controller,
    authorizes,
    reachActive,
    step,
  };
}

describe('N5 直连控制器回归', () => {
  test('A：两次慢 attempt 超时后网络恢复，下一次授权即打通，不出现 capacity、不进冷却', async () => {
    const s = setup({ nodeModel: true });
    s.controller.start();
    await flush();
    await s.step(15_000 + 1_000 + 15_000);
    const healedAt = s.clock.now;
    let successAt: number | null = null;
    let seen: string | null = null;
    for (let t = 0; t < 120_000 && successAt === null; t += 500) {
      await s.step(500);
      const current = s.controller.rtcSession;
      if (current && current !== seen && s.node.granted.includes(current)) {
        seen = current;
        await s.reachActive();
        if (s.controller.getState() === 'active') successAt = s.clock.now;
      }
    }
    expect(s.node.busy).toBe(0);
    expect(successAt).not.toBeNull();
    expect((successAt ?? Number.POSITIVE_INFINITY) - healedAt).toBeLessThanOrEqual(5_000);
    expect(s.controller.diagnostics().cooling).toBe(false);
  });

  test('B：自动重试只受熔断约束，冷却中 `/mesh/ws` 反复重连不额外拉起请求', async () => {
    const s = setup();
    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 500, body: { code: 'X' } });
    s.controller.start();
    await flush();
    await s.step(600_000);
    const capped = s.authorizes();
    expect(capped).toBeLessThanOrEqual(8);
    expect(directBreakerGate(NODE, s.clock.now).allow).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      s.signaling.setReady(false);
      s.signaling.setReady(true);
      await flush();
      await s.step(1_000);
    }
    expect(s.authorizes()).toBe(capped);
  });

  test('C：active 时的网络变化 / 页面恢复（nudge）不拆直连、不重新授权', async () => {
    const s = setup();
    s.controller.start();
    await s.reachActive();
    expect(s.controller.getState()).toBe('active');
    const before = s.authorizes();
    for (let i = 0; i < 3; i += 1) {
      s.clock.advance(NUDGE_COALESCE_MS);
      s.controller.nudge();
      await flush();
    }
    expect(s.connection.detachCount).toBe(0);
    expect(s.authorizes()).toBe(before);
    expect(s.controller.getState()).toBe('active');
  });

  test('D：primary 反复断开不算直连失败，熔断不打开，primary 回来即重新打通', async () => {
    const s = setup();
    s.controller.start();
    for (let i = 0; i < 3; i += 1) {
      await s.reachActive();
      expect(s.controller.getState()).toBe('active');
      s.connection.dropPrimary();
      await flush();
      expect(s.controller.getState()).toBe('idle');
      s.connection.setPrimaryState('READY');
      await flush();
      s.clock.advance(5_000);
      await flush();
    }
    await s.reachActive();
    expect(s.controller.getState()).toBe('active');
    expect(s.controller.diagnostics()).toMatchObject({ cooling: false, failures: 0 });
  });

  test('E：一次 DIRECT_BUSY 只记一次账', async () => {
    const s = setup();
    s.api.routes.set(RTC_AUTHORIZE_PATH, {
      status: 503,
      body: { code: 'DIRECT_BUSY', reason: 'capacity', retryAfterMs: 1000 },
    });
    s.controller.start();
    await flush();
    expect(s.controller.diagnostics()).toMatchObject({
      failures: 1,
      lastFailureKind: 'direct-busy',
    });
  });
});

describe('N5 直连 × 真实 primary 客户端', () => {
  function switchToDirect(rtcSession: string): Uint8Array {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchSchema, {
      epoch: 1,
      to: wsBorsh.CARRIER_SWITCH_TO_DIRECT,
      rtcSession,
    });
    return wsBorsh.encodeEnvelope(wsBorsh.KIND_CARRIER_SWITCH, payload, 0);
  }

  test('直连活跃时 primary 断开：不补齐订阅、不弹回落提示、不计入熔断，READY 后重新拨', async () => {
    const sockets: FakeSocket[] = [];
    const connection = createGatewayConnection({
      wsUrl: 'ws://example.test/n/node-b/ws',
      socketFactory: () => {
        const socket = createFakeSocket();
        sockets.push(socket);
        return socket;
      },
      clientOptions: { heartbeatIntervalMs: 60_000 },
    });
    let resumes = 0;
    connection.setResumeSubscribedPanes(() => {
      resumes += 1;
    });
    const clock = new ManualClock();
    const api = new FakeApiClient({
      [MESH_CONNECTION_PATH]: { body: { connectionId: 'c1' } },
      [RTC_CONFIG_PATH]: { body: { stun: [], turn: null } },
      [RTC_AUTHORIZE_PATH]: { body: GRANT },
    });
    const signaling = new FakeSignaling();
    const peers: FakePeerConnection[] = [];
    const controller = new DirectCarrierController({
      nodeId: NODE,
      apiClient: api,
      signaling,
      connection,
      rtcFactory: () => {
        const pc = new FakePeerConnection();
        peers.push(pc);
        return pc;
      },
      now: () => clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      visibility: { hidden: () => true, subscribe: () => () => undefined },
    });
    const ready = () => {
      const socket = sockets[sockets.length - 1] as FakeSocket;
      socket.open();
      socket.deliver(helloFrame());
    };
    connection.client.connect();
    ready();
    controller.start();
    await flush();
    const rtcSession = controller.rtcSession as string;
    signaling.deliver({
      rtcSession,
      from: 'node',
      to: NODE,
      sdp: JSON.stringify({ type: 'answer', sdp: sdpWithFingerprint(FP_NODE_VALUE, 'answer') }),
      candidate: null,
    });
    await flush();
    const pc = peers[0] as FakePeerConnection;
    pc.channel.open();
    await flush();
    (sockets[0] as FakeSocket).deliver(switchToDirect(rtcSession));
    await flush();
    expect(controller.getState()).toBe('active');
    expect(connection.activeCarrier).toBe('direct');

    (sockets[0] as FakeSocket).simulateClose(1011, 'failover-exhausted');
    await flush();
    expect(resumes).toBe(0);
    expect(pc.closeCount).toBe(1);
    expect(controller.getState()).toBe('idle');
    expect(controller.diagnostics()).toMatchObject({ failures: 0, cooling: false });

    connection.client.connect();
    ready();
    await flush();
    expect(peers.length).toBe(2);
    expect(controller.getState()).toBe('connecting');
    controller.stop();
    connection.dispose();
  });
});
