import { describe, expect, test } from 'bun:test';
import {
  DirectCarrierController,
  type DirectCarrierControllerOptions,
  RTC_AUTHORIZE_PATH,
  RTC_CONFIG_PATH,
  buildIceServers,
} from './direct-carrier-controller';
import {
  FP_BROWSER_VALUE,
  FP_NODE_VALUE,
  FakeApiClient,
  FakeConnection,
  FakePeerConnection,
  FakeSignaling,
  ManualClock,
  flush,
  sdpWithFingerprint,
  statsReport,
} from './test-fakes';

const NODE_ID = 'node-b';
const NONCE = 'bm9uY2UtMzJieXRlcw';

function normalized(value: string): string {
  return value.replace(/:/g, '').toUpperCase();
}

class FakeNetworkEvents {
  private readonly handlers = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.handlers.get(type)?.delete(cb);
  }

  emit(type: string): void {
    for (const cb of [...(this.handlers.get(type) ?? [])]) cb();
  }

  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

interface Setup {
  controller: DirectCarrierController;
  api: FakeApiClient;
  signaling: FakeSignaling;
  connection: FakeConnection;
  clock: ManualClock;
  network: FakeNetworkEvents;
  peers: FakePeerConnection[];
  pc(): FakePeerConnection;
}

function setup(overrides: Partial<DirectCarrierControllerOptions> = {}): Setup {
  const api = new FakeApiClient({
    [RTC_CONFIG_PATH]: { body: { stun: ['stun:stun.example:3478'], turn: null } },
    [RTC_AUTHORIZE_PATH]: {
      body: { nonce: NONCE, fp_node: { algorithm: 'sha-256', value: FP_NODE_VALUE } },
    },
  });
  const signaling = new FakeSignaling();
  const connection = new FakeConnection();
  const clock = new ManualClock();
  const network = new FakeNetworkEvents();
  const peers: FakePeerConnection[] = [];

  const controller = new DirectCarrierController({
    nodeId: NODE_ID,
    apiClient: api,
    signaling,
    connection,
    rtcSession: 'rs-1',
    rtcFactory: () => {
      const pc = new FakePeerConnection();
      peers.push(pc);
      return pc;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    networkEvents: network,
    ...overrides,
  });

  return {
    controller,
    api,
    signaling,
    connection,
    clock,
    network,
    peers,
    pc: () => {
      const last = peers[peers.length - 1];
      if (!last) throw new Error('no peer connection created');
      return last;
    },
  };
}

function answerSignal(fingerprint = FP_NODE_VALUE, rtcSession = 'rs-1') {
  return {
    rtcSession,
    from: 'node' as const,
    to: NODE_ID,
    sdp: JSON.stringify({ type: 'answer', sdp: sdpWithFingerprint(fingerprint, 'answer') }),
    candidate: null,
  };
}

async function reachActive(s: Setup): Promise<void> {
  s.controller.start();
  await flush();
  s.signaling.deliver(answerSignal());
  await flush();
  s.pc().channel.open();
  await flush();
}

describe('buildIceServers', () => {
  test('stun 数组 + turn 对象（url / urls / 数组）都被归一成 iceServers', () => {
    expect(buildIceServers({ stun: ['stun:a:3478', 'stun:b:3478'], turn: null })).toEqual([
      { urls: 'stun:a:3478' },
      { urls: 'stun:b:3478' },
    ]);
    expect(
      buildIceServers({
        stun: [],
        turn: { url: 'turn:t:3478', username: 'u', credential: 'c' },
      })
    ).toEqual([{ urls: 'turn:t:3478', username: 'u', credential: 'c' }]);
    expect(buildIceServers({ stun: [], turn: ['turn:a', { urls: ['turn:b', 'turn:c'] }] })).toEqual(
      [{ urls: 'turn:a' }, { urls: ['turn:b', 'turn:c'] }]
    );
    expect(buildIceServers(null)).toEqual([]);
  });
});

describe('DirectCarrierController happy path', () => {
  test('取 ICE 配置 → 建 sess 通道 → 用本地 SDP 指纹鉴权 → 发 offer', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    expect(s.api.calls[0]?.path).toBe(RTC_CONFIG_PATH);
    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    expect(authorize?.body).toEqual({
      rtcSession: 'rs-1',
      fp_browser: { algorithm: 'sha-256', value: normalized(FP_BROWSER_VALUE) },
    });

    const offer = s.signaling.sent[0];
    expect(offer?.from).toBe('browser');
    expect(offer?.to).toBe(NODE_ID);
    expect(JSON.parse(offer?.sdp ?? '{}')).toMatchObject({ type: 'offer' });
    expect(s.controller.getState()).toBe('connecting');
  });

  test('answer 指纹匹配后 setRemoteDescription；通道 open 时首帧发裸 JSON {nonce} 再挂载载体', async () => {
    const s = setup();
    await reachActive(s);

    expect(s.pc().remoteDescription?.type).toBe('answer');
    // 首帧必须未分片：node 侧在挂载载体前直接读这一条裸消息
    expect(s.pc().channel.firstMessageJson()).toEqual({ nonce: NONCE });
    expect(s.connection.attached.length).toBe(1);
    expect(s.controller.getState()).toBe('active');
    expect(s.controller.diagnostics().path).toBe('direct');
  });

  test('本地 ICE 候选上行，node 下发的候选被 addIceCandidate', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    s.pc().emitCandidate('candidate:1 1 udp 1 10.0.0.1 5000 typ host', '0');
    const candidateSignal = s.signaling.sent.find((sig) => sig.candidate);
    expect(JSON.parse(candidateSignal?.candidate ?? '{}')).toEqual({
      candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host',
      mid: '0',
    });

    s.signaling.deliver({
      rtcSession: 'rs-1',
      from: 'node',
      to: NODE_ID,
      sdp: null,
      candidate: JSON.stringify({
        candidate: 'candidate:2 1 udp 1 10.0.0.2 5000 typ host',
        mid: '0',
      }),
    });
    await flush();
    expect(s.pc().addedCandidates.length).toBe(1);
  });

  test('别的 rtcSession / from=browser 的信令一律忽略', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    s.signaling.deliver(answerSignal(FP_NODE_VALUE, 'other-session'));
    s.signaling.deliver({ ...answerSignal(), from: 'browser' });
    await flush();
    expect(s.pc().remoteDescription).toBeNull();
  });
});

describe('DirectCarrierController 指纹绑定', () => {
  test('远端 SDP 指纹与 fp_node 不一致时放弃直连，且不安排重试', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    s.signaling.deliver(answerSignal(FP_BROWSER_VALUE));
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('fingerprint mismatch');
    expect(s.pc().remoteDescription).toBeNull();
    expect(s.pc().closeCount).toBe(1);
    expect(s.connection.attached.length).toBe(0);
    expect(s.clock.pendingDelays).toEqual([]);
  });

  test('authorize 返回 4xx 时不重试；5xx 时退避重试', async () => {
    const fatal = setup();
    fatal.api.routes.set(RTC_AUTHORIZE_PATH, { status: 403, body: { error: 'FORBIDDEN' } });
    fatal.controller.start();
    await flush();
    expect(fatal.controller.getState()).toBe('failed');
    expect(fatal.clock.pendingDelays).toEqual([]);

    const retryable = setup();
    retryable.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: { error: 'UNAVAILABLE' } });
    retryable.controller.start();
    await flush();
    expect(retryable.controller.getState()).toBe('failed');
    expect(retryable.clock.pendingDelays).toEqual([1000]);
  });
});

describe('DirectCarrierController 退避与网络变化', () => {
  test('退避 1s → 2s → 4s …，达到上限后停在 failed，retry() 重置', async () => {
    const s = setup({ maxAttempts: 3 });
    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: {} });

    s.controller.start();
    await flush();
    expect(s.clock.pendingDelays).toEqual([1000]);

    s.clock.advance(1000);
    await flush();
    expect(s.clock.pendingDelays).toEqual([2000]);

    s.clock.advance(2000);
    await flush();
    expect(s.clock.pendingDelays).toEqual([4000]);

    s.clock.advance(4000);
    await flush();
    // 已用满 3 次重试，不再排队
    expect(s.clock.pendingDelays).toEqual([]);
    expect(s.controller.getState()).toBe('failed');

    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: {} });
    s.controller.retry();
    await flush();
    expect(s.clock.pendingDelays).toEqual([1000]);
  });

  test('retryDelay 上限 30 s', () => {
    const s = setup();
    expect(s.controller.retryDelay(0)).toBe(1000);
    expect(s.controller.retryDelay(4)).toBe(16_000);
    expect(s.controller.retryDelay(10)).toBe(30_000);
  });

  test('online 事件重置退避并立刻重连；stop() 注销监听', async () => {
    const s = setup({ maxAttempts: 1 });
    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: {} });
    s.controller.start();
    await flush();
    s.clock.advance(1000);
    await flush();
    expect(s.controller.getState()).toBe('failed');
    expect(s.clock.pendingDelays).toEqual([]);
    const before = s.peers.length;

    s.network.emit('online');
    await flush();
    expect(s.peers.length).toBeGreaterThan(before);

    s.controller.stop();
    expect(s.network.count('online')).toBe(0);
    expect(s.controller.getState()).toBe('idle');
  });

  test('直连通道被关闭（如 primary 断开触发屏障 closeDirect）后退避重连', async () => {
    const s = setup();
    await reachActive(s);
    expect(s.controller.getState()).toBe('active');

    s.pc().channel.simulateClose();
    expect(s.controller.getState()).toBe('failed');
    expect(s.clock.pendingDelays).toEqual([1000]);
    expect(s.connection.detachCount).toBeGreaterThan(0);
  });

  test('连接超时后判失败并重试', async () => {
    const s = setup({ connectTimeoutMs: 5000 });
    s.controller.start();
    await flush();
    expect(s.clock.pendingDelays).toEqual([5000]);

    s.clock.advance(5000);
    await flush();
    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('timeout');
  });

  test('stop() 关闭 PeerConnection 并回到 idle', async () => {
    const s = setup();
    await reachActive(s);
    s.controller.stop();
    expect(s.pc().closeCount).toBe(1);
    expect(s.controller.getState()).toBe('idle');
    expect(s.controller.diagnostics().path).toBe('primary');
  });
});

describe('DirectCarrierController 诊断', () => {
  test('从 getStats 推出 path 与 rtt，并写进 ICE 诊断', async () => {
    const s = setup();
    await reachActive(s);
    s.pc().connectionState = 'connected';
    s.pc().iceConnectionState = 'connected';
    s.pc().stats = statsReport([
      { id: 'L', type: 'local-candidate', candidateType: 'host', address: '10.0.0.1' },
      { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '10.0.0.2' },
      {
        id: 'P',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L',
        remoteCandidateId: 'R',
        currentRoundTripTime: 0.004,
      },
    ]);

    await s.controller.pollStats();
    expect(s.controller.path).toBe('lan');
    expect(s.controller.rtt).toBeCloseTo(4, 3);

    const diag = s.controller.diagnostics();
    expect(diag.path).toBe('direct');
    expect(diag.ice).toMatchObject({
      connectionState: 'connected',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      selectedPair: 'host → host',
    });
  });

  test('TURN 候选 → path=turn；未 active 时 path 为 null', async () => {
    const s = setup();
    await reachActive(s);
    s.pc().stats = statsReport([
      { id: 'L', type: 'local-candidate', candidateType: 'relay', address: '203.0.113.9' },
      { id: 'R', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.4' },
      {
        id: 'P',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L',
        remoteCandidateId: 'R',
      },
    ]);
    await s.controller.pollStats();
    expect(s.controller.path).toBe('turn');

    s.controller.stop();
    expect(s.controller.path).toBeNull();
  });

  test('diagnosticsSource 快照引用稳定，变化时通知订阅者', async () => {
    const s = setup();
    let notified = 0;
    const unsubscribe = s.controller.diagnosticsSource.subscribe(() => {
      notified += 1;
    });
    const first = s.controller.diagnosticsSource.get();
    expect(s.controller.diagnosticsSource.get()).toBe(first);

    await reachActive(s);
    expect(notified).toBeGreaterThan(0);
    expect(s.controller.diagnosticsSource.get().path).toBe('direct');

    unsubscribe();
    const stable = s.controller.diagnosticsSource.get();
    expect(s.controller.diagnosticsSource.get()).toBe(stable);
  });
});
