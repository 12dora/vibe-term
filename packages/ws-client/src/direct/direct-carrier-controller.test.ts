import { describe, expect, test } from 'bun:test';
import {
  DirectCarrierController,
  type DirectCarrierControllerOptions,
  MESH_CONNECTION_PATH,
  RTC_AUTHORIZE_PATH,
  RTC_CONFIG_PATH,
  X_TMEX_CONNECTION_HEADER,
  buildIceServers,
  meshConnectionPath,
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
const CONNECTION_ID = 'conn-tab-1';

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
  netInfo: FakeNetworkEvents;
  peers: FakePeerConnection[];
  pc(): FakePeerConnection;
  session(): string;
}

function setup(overrides: Partial<DirectCarrierControllerOptions> = {}): Setup {
  const api = new FakeApiClient({
    [MESH_CONNECTION_PATH]: { body: { connectionId: CONNECTION_ID } },
    [RTC_CONFIG_PATH]: { body: { stun: ['stun:stun.example:3478'], turn: null } },
    [RTC_AUTHORIZE_PATH]: {
      body: { nonce: NONCE, fp_node: { algorithm: 'sha-256', value: FP_NODE_VALUE } },
    },
  });
  const signaling = new FakeSignaling();
  const connection = new FakeConnection();
  const clock = new ManualClock();
  const network = new FakeNetworkEvents();
  const netInfo = new FakeNetworkEvents();
  const peers: FakePeerConnection[] = [];

  const controller = new DirectCarrierController({
    nodeId: NODE_ID,
    apiClient: api,
    signaling,
    connection,
    rtcFactory: () => {
      const pc = new FakePeerConnection();
      peers.push(pc);
      return pc;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    networkEvents: network,
    connectionEvents: netInfo,
    ...overrides,
  });

  return {
    controller,
    api,
    signaling,
    connection,
    clock,
    network,
    netInfo,
    peers,
    pc: () => {
      const last = peers[peers.length - 1];
      if (!last) throw new Error('no peer connection created');
      return last;
    },
    session: () => {
      const session = controller.rtcSession;
      if (!session) throw new Error('no rtcSession');
      return session;
    },
  };
}

function answerSignal(s: Setup, fingerprint = FP_NODE_VALUE, rtcSession?: string) {
  return {
    rtcSession: rtcSession ?? s.session(),
    from: 'node' as const,
    to: NODE_ID,
    sdp: JSON.stringify({ type: 'answer', sdp: sdpWithFingerprint(fingerprint, 'answer') }),
    candidate: null,
  };
}

/** 建连 + 屏障切换：只有 `onCarrierChange('direct')` 之后控制器才算 active。 */
async function reachActive(s: Setup): Promise<void> {
  s.controller.start();
  await flush();
  s.signaling.deliver(answerSignal(s));
  await flush();
  s.pc().channel.open();
  await flush();
  s.connection.switchTo('direct');
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

    // connectionId 先取：拿不到就不该白建一条 PeerConnection
    expect(s.api.calls.map((c) => c.path).slice(0, 2)).toEqual([
      MESH_CONNECTION_PATH,
      RTC_CONFIG_PATH,
    ]);
    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    expect(authorize?.body).toEqual({
      rtcSession: s.session(),
      fp_browser: { algorithm: 'sha-256', value: normalized(FP_BROWSER_VALUE) },
      connectionId: CONNECTION_ID,
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
    await flush();
    const candidateSignal = s.signaling.candidates[0];
    expect(JSON.parse(candidateSignal?.candidate ?? '{}')).toEqual({
      candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host',
      mid: '0',
    });

    s.signaling.deliver(answerSignal(s));
    await flush();
    s.signaling.deliver({
      rtcSession: s.session(),
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

    s.signaling.deliver(answerSignal(s, FP_NODE_VALUE, 'other-session'));
    s.signaling.deliver({ ...answerSignal(s), from: 'browser' });
    await flush();
    expect(s.pc().remoteDescription).toBeNull();
  });
});

describe('DirectCarrierController connectionId 绑定（F3-4）', () => {
  test('authorize 同时用 body 与 x-tmex-connection 头带上 connectionId', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    expect((authorize?.body as { connectionId?: string }).connectionId).toBe(CONNECTION_ID);
    expect(authorize?.headers[X_TMEX_CONNECTION_HEADER]).toBe(CONNECTION_ID);
  });

  test('每次尝试都重取 connectionId：primary 重连后换成新值', async () => {
    const s = setup();
    s.controller.start();
    await flush();
    expect(s.api.calls.filter((c) => c.path === MESH_CONNECTION_PATH).length).toBe(1);

    s.api.routes.set(MESH_CONNECTION_PATH, { body: { connectionId: 'conn-tab-2' } });
    s.controller.retry();
    await flush();

    const lookups = s.api.calls.filter((c) => c.path === MESH_CONNECTION_PATH);
    expect(lookups.length).toBe(2);
    const ids = s.api.calls
      .filter((c) => c.path === RTC_AUTHORIZE_PATH)
      .map((c) => (c.body as { connectionId?: string }).connectionId);
    expect(ids).toEqual([CONNECTION_ID, 'conn-tab-2']);
  });

  test('带 cid 查 connectionId：query 上是 nonce，authorize 用的是服务端 id（F3-5）', async () => {
    const s = setup({ cid: () => 'cid-tab-1' });
    s.controller.start();
    await flush();

    const lookup = s.api.calls.find((c) => c.path.startsWith(MESH_CONNECTION_PATH));
    expect(lookup?.path).toBe(`${MESH_CONNECTION_PATH}?cid=cid-tab-1`);

    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    // nonce 只是找回身份的索引，绝不能当成 connectionId 用
    expect((authorize?.body as { connectionId?: string }).connectionId).toBe(CONNECTION_ID);
    expect(authorize?.headers[X_TMEX_CONNECTION_HEADER]).toBe(CONNECTION_ID);
    expect(JSON.stringify(authorize?.body)).not.toContain('cid-tab-1');
  });

  test('nonce 每次尝试都现取：primary 重连换了 socket 就跟着换', async () => {
    let nonce = 'cid-1';
    const s = setup({ cid: () => nonce });
    s.controller.start();
    await flush();

    nonce = 'cid-2';
    s.controller.retry();
    await flush();

    expect(
      s.api.calls.filter((c) => c.path.startsWith(MESH_CONNECTION_PATH)).map((c) => c.path)
    ).toEqual([`${MESH_CONNECTION_PATH}?cid=cid-1`, `${MESH_CONNECTION_PATH}?cid=cid-2`]);
  });

  test('nonce 里的特殊字符被 URL 编码', () => {
    expect(meshConnectionPath('a/b+c=')).toBe(`${MESH_CONNECTION_PATH}?cid=a%2Fb%2Bc%3D`);
    // 宿主没接线 / 还没建过 socket：退化成不带 cid 的旧查询
    expect(meshConnectionPath(null)).toBe(MESH_CONNECTION_PATH);
    expect(meshConnectionPath(undefined)).toBe(MESH_CONNECTION_PATH);
    expect(meshConnectionPath('')).toBe(MESH_CONNECTION_PATH);
  });

  test('409 MULTIPLE_CONNECTIONS：不建 PC、不消耗退避，等 primary 重连过再来', async () => {
    const s = setup();
    s.api.routes.set(MESH_CONNECTION_PATH, {
      status: 409,
      body: { code: 'MULTIPLE_CONNECTIONS', hint: 'send x-tmex-connection' },
    });
    s.controller.start();
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('MULTIPLE_CONNECTIONS');
    // 退避定时器一个都不排：多标签下重试多少次都还是 409
    expect(s.clock.pendingDelays).toEqual([]);
    expect(s.peers.length).toBe(0);
    expect(s.api.calls.some((c) => c.path === RTC_AUTHORIZE_PATH)).toBe(false);
    expect(s.connection.primaryHandlerCount).toBe(1);

    // primary 只是抖一下还没回来：不重来
    s.connection.setPrimaryState('WS_CONNECTING');
    await flush();
    expect(s.peers.length).toBe(0);

    // 重连完成（此时只剩本标签页）→ 立刻重来一轮并跑通
    s.api.routes.set(MESH_CONNECTION_PATH, { body: { connectionId: 'conn-tab-3' } });
    s.connection.setPrimaryState('READY');
    await flush();
    expect(s.controller.getState()).toBe('connecting');
    expect(s.connection.primaryHandlerCount).toBe(0);
    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    expect((authorize?.body as { connectionId?: string }).connectionId).toBe('conn-tab-3');
  });

  test('404 NO_CONNECTION 且 primary 未就绪：等它连上；已就绪则按登记竞态退避重试', async () => {
    const waiting = setup();
    waiting.api.routes.set(MESH_CONNECTION_PATH, { status: 404, body: { code: 'NO_CONNECTION' } });
    waiting.connection.setPrimaryState('RECONNECT_BACKOFF');
    waiting.controller.start();
    await flush();

    expect(waiting.controller.getState()).toBe('failed');
    expect(waiting.clock.pendingDelays).toEqual([]);
    waiting.api.routes.set(MESH_CONNECTION_PATH, { body: { connectionId: CONNECTION_ID } });
    waiting.connection.setPrimaryState('READY');
    await flush();
    expect(waiting.controller.getState()).toBe('connecting');
    expect(waiting.api.calls.some((c) => c.path === RTC_AUTHORIZE_PATH)).toBe(true);

    const racing = setup();
    racing.api.routes.set(MESH_CONNECTION_PATH, { status: 404, body: { code: 'NO_CONNECTION' } });
    racing.controller.start();
    await flush();
    expect(racing.controller.getState()).toBe('failed');
    expect(racing.clock.pendingDelays).toEqual([1000]);
  });

  test('authorize 自己回 409 时同样改成等 primary，而不是当 4xx 永久失败', async () => {
    const s = setup();
    s.api.routes.set(RTC_AUTHORIZE_PATH, {
      status: 409,
      body: { code: 'MULTIPLE_CONNECTIONS' },
    });
    s.controller.start();
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.clock.pendingDelays).toEqual([]);
    expect(s.connection.primaryHandlerCount).toBe(1);
  });

  test('老 node（该路由 405）退化成不带 connectionId 的旧行为', async () => {
    const s = setup();
    s.api.routes.set(MESH_CONNECTION_PATH, {
      status: 405,
      body: { code: 'method_not_allowed' },
    });
    s.controller.start();
    await flush();

    const authorize = s.api.calls.find((c) => c.path === RTC_AUTHORIZE_PATH);
    expect(authorize?.body).toEqual({
      rtcSession: s.session(),
      fp_browser: { algorithm: 'sha-256', value: normalized(FP_BROWSER_VALUE) },
    });
    expect(authorize?.headers[X_TMEX_CONNECTION_HEADER]).toBeUndefined();
    expect(s.controller.getState()).toBe('connecting');
  });

  test('lookup 5xx 走普通退避；宿主没有 primary 状态源时 409 也退回退避', async () => {
    const server = setup();
    server.api.routes.set(MESH_CONNECTION_PATH, { status: 503, body: { code: 'UNAVAILABLE' } });
    server.controller.start();
    await flush();
    expect(server.controller.getState()).toBe('failed');
    expect(server.clock.pendingDelays).toEqual([1000]);

    const legacy = setup();
    legacy.connection.exposePrimaryStatus = false;
    legacy.api.routes.set(MESH_CONNECTION_PATH, {
      status: 409,
      body: { code: 'MULTIPLE_CONNECTIONS' },
    });
    legacy.controller.start();
    await flush();
    expect(legacy.controller.getState()).toBe('failed');
    expect(legacy.clock.pendingDelays).toEqual([1000]);
  });

  test('stop() 注销 primary 等待订阅', async () => {
    const s = setup();
    s.api.routes.set(MESH_CONNECTION_PATH, {
      status: 409,
      body: { code: 'MULTIPLE_CONNECTIONS' },
    });
    s.controller.start();
    await flush();
    expect(s.connection.primaryHandlerCount).toBe(1);

    s.controller.stop();
    expect(s.connection.primaryHandlerCount).toBe(0);
  });
});

describe('DirectCarrierController 指纹绑定', () => {
  test('远端 SDP 指纹与 fp_node 不一致时放弃直连，且不安排重试', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    s.signaling.deliver(answerSignal(s, FP_BROWSER_VALUE));
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('fingerprint mismatch');
    expect(s.peers[0]?.remoteDescription).toBeNull();
    expect(s.peers[0]?.closeCount).toBe(1);
    expect(s.connection.attached.length).toBe(0);
    expect(s.clock.pendingDelays).toEqual([]);
  });

  test('answer 的 m=application 段被注入攻击者指纹（session 级仍是 fp_node）同样拒绝', async () => {
    const s = setup();
    s.controller.start();
    await flush();

    const spoofed = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      `a=fingerprint:sha-256 ${FP_NODE_VALUE}`,
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      `a=fingerprint:sha-256 ${FP_BROWSER_VALUE}`,
      'a=mid:0',
    ].join('\r\n');
    s.signaling.deliver({
      rtcSession: s.session(),
      from: 'node',
      to: NODE_ID,
      sdp: JSON.stringify({ type: 'answer', sdp: spoofed }),
      candidate: null,
    });
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('fingerprint mismatch');
    expect(s.peers[0]?.remoteDescription).toBeNull();
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

describe('DirectCarrierController attempt 生命周期', () => {
  test('每次尝试换新的 rtcSession（node 按它缓存 PeerConnection）', async () => {
    const s = setup({ maxAttempts: 3 });
    s.controller.start();
    await flush();
    const first = s.session();

    s.controller.retry();
    await flush();
    const second = s.session();
    expect(second).not.toBe(first);
    // authorize 用的是各自 attempt 的 session
    const sessions = s.api.calls
      .filter((c) => c.path === RTC_AUTHORIZE_PATH)
      .map((c) => (c.body as { rtcSession: string }).rtcSession);
    expect(sessions).toEqual([first, second]);
    // 旧 session 的 answer 不再被接受
    s.signaling.deliver(answerSignal(s, FP_NODE_VALUE, first));
    await flush();
    expect(s.pc().remoteDescription).toBeNull();
  });

  test('retry() 关掉被替换 attempt 的 PeerConnection', async () => {
    const s = setup();
    s.controller.start();
    await flush();
    const first = s.pc();

    s.controller.retry();
    await flush();
    expect(first.closeCount).toBe(1);
    expect(s.pc()).not.toBe(first);
    expect(s.peers.length).toBe(2);
  });

  test('RTC 配置请求未回时 retry()：不会并发两个 attempt', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup();
    const originalFetch = s.api.fetch.bind(s.api);
    let firstConfig = true;
    s.api.fetch = async (path: string, init?: RequestInit) => {
      if (path === RTC_CONFIG_PATH && firstConfig) {
        firstConfig = false;
        await gate;
      }
      return originalFetch(path, init);
    };

    s.controller.start();
    await flush(1);
    // 第一次 attempt 卡在 rtc-config 上，此时网络事件触发 retry()
    s.network.emit('online');
    await flush();
    expect(s.peers.length).toBe(1); // 第二代已建 PC，第一代还卡着

    release();
    await flush();
    // 第一代恢复后发现自己已被替换：既不建 PC 也不覆盖 this.attempt
    expect(s.peers.length).toBe(1);
    expect(s.api.calls.filter((c) => c.path === RTC_AUTHORIZE_PATH).length).toBe(1);
    expect(s.controller.getState()).toBe('connecting');

    // 当代仍可正常走完
    s.signaling.deliver(answerSignal(s));
    await flush();
    s.pc().channel.open();
    await flush();
    s.connection.switchTo('direct');
    expect(s.controller.getState()).toBe('active');
  });

  test('旧 attempt 的失败不会拆掉新 attempt', async () => {
    const s = setup();
    s.controller.start();
    await flush();
    const stalePc = s.pc();

    s.controller.retry();
    await flush();
    const current = s.pc();
    expect(current).not.toBe(stalePc);

    // 旧 PC 迟来的 failed 回调（已注销，但即使触发也必须按 generation 忽略）
    stalePc.onconnectionstatechange?.();
    stalePc.setConnectionState('failed');
    await flush();
    expect(s.controller.getState()).toBe('connecting');
    expect(current.closeCount).toBe(0);
  });
});

describe('DirectCarrierController 信令就绪', () => {
  test('信令未就绪时不开 attempt；恢复后重置退避并重连', async () => {
    const s = setup();
    s.signaling.setReady(false);
    s.controller.start();
    await flush();
    expect(s.peers.length).toBe(0);
    expect(s.controller.getState()).toBe('failed');

    s.signaling.setReady(true);
    await flush();
    expect(s.peers.length).toBe(1);
    expect(s.controller.getState()).toBe('connecting');
  });

  test('attempt 中途信令断开：信令排队，恢复后按序补发（offer 在候选之前）', async () => {
    const s = setup();
    s.controller.start();
    await flush();
    expect(s.signaling.sent.length).toBe(1);

    s.signaling.setReady(false);
    s.pc().emitCandidate('candidate:1 1 udp 1 10.0.0.1 5000 typ host');
    s.pc().emitCandidate('candidate:2 1 udp 1 10.0.0.2 5000 typ host');
    await flush();
    expect(s.signaling.candidates.length).toBe(0);

    s.signaling.setReady(true);
    await flush();
    expect(s.signaling.candidates.length).toBe(2);
    expect(JSON.parse(s.signaling.candidates[0]?.candidate ?? '{}').candidate).toContain(
      'candidate:1'
    );
  });

  test('offer 送不出去时后续候选不会插到 offer 前面', async () => {
    const s = setup();
    s.signaling.setReady(false);
    s.controller.start();
    await flush();
    // 未就绪 → 连 attempt 都没开
    expect(s.signaling.sent.length).toBe(0);

    s.signaling.setReady(true);
    await flush();
    s.pc().emitCandidate('candidate:1 1 udp 1 10.0.0.1 5000 typ host');
    await flush();
    expect(s.signaling.sent[0]?.sdp).not.toBeNull();
    expect(s.signaling.sent[1]?.candidate).not.toBeNull();
  });
});

describe('DirectCarrierController 载体切换与激活', () => {
  test('通道 open 只是挂载：仍是 connecting，超时未撤销', async () => {
    const s = setup({ connectTimeoutMs: 5000 });
    s.controller.start();
    await flush();
    s.signaling.deliver(answerSignal(s));
    await flush();
    s.pc().channel.open();
    await flush();

    expect(s.connection.attached.length).toBe(1);
    expect(s.controller.getState()).toBe('connecting');
    expect(s.clock.pendingDelays).toEqual([5000]);

    s.connection.switchTo('direct');
    expect(s.controller.getState()).toBe('active');
    // 连接超时已撤销，只剩 stats 轮询；再走过原超时点也不会判失败
    expect(s.clock.pendingDelays).toEqual([2000]);
    s.clock.advance(6000);
    await flush();
    expect(s.controller.getState()).toBe('active');
  });

  test('node 挂载后立刻关通道：重试计数不清零，退避继续增长', async () => {
    const s = setup({ maxAttempts: 3 });
    s.controller.start();
    await flush();
    s.signaling.deliver(answerSignal(s));
    await flush();
    s.pc().channel.open();
    await flush();
    // 没有 CARRIER_SWITCH，node 直接因 nonce 校验失败关掉通道
    s.pc().channel.simulateClose();
    await flush();
    expect(s.controller.getState()).toBe('failed');
    expect(s.clock.pendingDelays).toEqual([1000]);

    s.clock.advance(1000);
    await flush();
    s.signaling.deliver(answerSignal(s));
    await flush();
    s.pc().channel.open();
    await flush();
    s.pc().channel.simulateClose();
    await flush();
    // 从 1 s 重来的话这里还是 1000
    expect(s.clock.pendingDelays).toEqual([2000]);
  });

  test('入站分片协议违规：载体自毁，控制器按失败退避并给出原因', async () => {
    const s = setup();
    await reachActive(s);

    // total=65535 的恶意分片
    const malicious = new Uint8Array(16);
    malicious[6] = 0xff;
    malicious[7] = 0xff;
    s.pc().channel.deliver(malicious);
    await flush();

    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('protocol violation');
    expect(s.clock.pendingDelays).toEqual([1000]);
  });

  test('切回 primary（onCarrierChange）按载体失效处理，退避重连', async () => {
    const s = setup();
    await reachActive(s);
    s.connection.switchTo('primary');
    await flush();
    expect(s.controller.getState()).toBe('failed');
    expect(s.clock.pendingDelays).toEqual([1000]);
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
    expect(s.netInfo.count('change')).toBe(0);
    expect(s.controller.getState()).toBe('idle');
  });

  test('stop() 后再 start()：网络监听只挂一份，online 只重连一次', async () => {
    const s = setup({ maxAttempts: 1 });
    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: {} });
    s.controller.start();
    await flush();
    s.controller.stop();
    expect(s.network.count('online')).toBe(0);

    s.controller.start();
    await flush();
    s.clock.advance(1000);
    await flush();
    expect(s.network.count('online')).toBe(1);
    expect(s.netInfo.count('change')).toBe(1);

    const before = s.peers.length;
    s.network.emit('online');
    await flush();
    expect(s.peers.length).toBe(before + 1);
  });

  test('navigator.connection 的 change 去抖后重连（Wi-Fi → 蜂窝不发 online）', async () => {
    const s = setup({ maxAttempts: 1, networkChangeDebounceMs: 800 });
    s.api.routes.set(RTC_AUTHORIZE_PATH, { status: 503, body: {} });
    s.controller.start();
    await flush();
    s.clock.advance(1000);
    await flush();
    const before = s.peers.length;

    s.netInfo.emit('change');
    s.netInfo.emit('change');
    s.netInfo.emit('change');
    await flush();
    expect(s.peers.length).toBe(before); // 去抖窗口内不动

    s.clock.advance(800);
    await flush();
    expect(s.peers.length).toBe(before + 1); // 只重连一次
  });

  test('iceConnectionState=disconnected 宽限 5 s 后回落 primary 并重来', async () => {
    const s = setup({ iceDisconnectGraceMs: 5000 });
    await reachActive(s);
    const pc = s.pc();

    pc.setIceConnectionState('disconnected');
    await flush();
    expect(s.controller.getState()).toBe('active');

    s.clock.advance(4999);
    await flush();
    expect(s.controller.getState()).toBe('active');

    s.clock.advance(1);
    await flush();
    expect(s.controller.getState()).toBe('failed');
    expect(s.controller.reason).toContain('ice disconnected');
    expect(pc.closeCount).toBe(1);
    expect(s.connection.detachCount).toBeGreaterThan(0);
    expect(s.clock.pendingDelays).toEqual([1000]);
  });

  test('disconnected 在宽限期内恢复 connected 时不回落', async () => {
    const s = setup({ iceDisconnectGraceMs: 5000 });
    await reachActive(s);
    s.pc().setIceConnectionState('disconnected');
    await flush();
    s.pc().setIceConnectionState('connected');
    await flush();
    s.clock.advance(10_000);
    await flush();
    expect(s.controller.getState()).toBe('active');
  });

  test('直连通道被关闭（如 primary 断开触发屏障 closeDirect）后退避重连', async () => {
    const s = setup();
    await reachActive(s);
    expect(s.controller.getState()).toBe('active');

    s.pc().channel.simulateClose();
    await flush();
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
  test('从 getStats 推出 route 与 rtt，并写进 ICE 诊断快照', async () => {
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
    // route 与 path 分开发布：path 只说走不走直连，route 说直连走的哪条网络路径
    expect(diag.route).toBe('lan');
    expect(diag.ice).toMatchObject({
      connectionState: 'connected',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      selectedPair: 'host → host',
    });
  });

  test('TURN 候选 → route=turn；未 active 时 route / path 均为 null', async () => {
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
    expect(s.controller.diagnostics().route).toBe('turn');

    s.controller.stop();
    expect(s.controller.path).toBeNull();
    expect(s.controller.diagnostics().route).toBeNull();
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

  test('createDataChannel 只在 active 时可用（bulk 通道走它）', async () => {
    const s = setup();
    expect(() => s.controller.createDataChannel('bulk:1')).toThrow('direct carrier not active');

    await reachActive(s);
    const channel = s.controller.createDataChannel('bulk:1', { ordered: true });
    expect(channel).toBeDefined();
    expect(s.pc().channels.length).toBe(2);

    s.controller.stop();
    expect(() => s.controller.createDataChannel('bulk:2')).toThrow('direct carrier not active');
  });
});
