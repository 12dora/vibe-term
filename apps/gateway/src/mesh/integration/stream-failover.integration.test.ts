import { afterEach, describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, wsBorsh } from '@vibeterm/shared';
import type { AuthDb } from '../../auth/types';
import { bootRelayMeshHarness, waitUntil } from '../../relay/integration/relay-mesh-harness';
import type { GatewayRuntime } from '../../runtime';
import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../../tmux-client/device-session-runtime';
import {
  PaneRetention,
  type PaneRetentionConsumerCallbacks,
} from '../../tmux-client/pane-retention';
import { WebSocketServer } from '../../ws';
import { MESH_FORWARD_WS_KIND, type MeshServerWebSocket } from '../mesh-deps';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { requestDispatchContext } from '../types';
import {
  type BootUser,
  jarFor,
  loginRemote,
  loginSelf,
  selfCookie,
  sidFromResponse,
} from './mesh-http-helpers';

function fakeGateway(db: AuthDb, wsServer?: WebSocketServer): GatewayRuntime {
  const server = wsServer ?? new WebSocketServer();
  return {
    port: 0,
    db,
    wsServer: server,
    handleRequest: () => undefined,
    dispatchHttp: async (req, ctx) => {
      requestDispatchContext.set(req, { uid: ctx.uid ?? '', viaNodeId: ctx.viaNodeId });
      return new Response('not-found', { status: 404 });
    },
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

const DEVICE_ID = 'local';
const PANE_ID = '%1';
const SERVER_EPOCH = new Uint8Array(16).fill(0x5a);
const PANE_EPOCH = new Uint8Array(16).fill(0x2b);
const encoder = new TextEncoder();

function paneSnapshot(deviceId: string): StateSnapshotPayload {
  return {
    deviceId,
    session: {
      id: '$1',
      name: 'VibeTerm',
      windows: [
        {
          id: '@1',
          name: 'one',
          index: 0,
          active: true,
          panes: [
            {
              id: PANE_ID,
              windowId: '@1',
              index: 0,
              title: 'one-pane',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
      ],
    },
  };
}

/**
 * 节点侧的假设备运行时：终端输出走真正的 PaneRetention。
 * 浏览器拿到的每一帧 PaneData 因此都必须经过「订阅被接受 → 保留区扇出 / 游标重放」，
 * 而不是由测试直接往 GatewaySession 灌帧——切换后的连续性才有意义。
 */
class FailoverPaneRuntime {
  // routeGraceMs 默认 2s：慢切换（DC 熔断后退到 relay）会超窗，pane 直接停止保留。
  // 这里放宽，让「按游标重放」这条真实路径在慢切换下也被覆盖；真丢数据时仍会报 gap。
  readonly retention = new PaneRetention({ routeGraceMs: 30_000, replayTtlMs: 60_000 });
  readonly listeners = new Set<DeviceSessionRuntimeListener>();
  openConsumers = 0;
  private emitted = 0;

  constructor(readonly deviceId: string = DEVICE_ID) {
    this.retention.reconcilePanes([{ paneId: PANE_ID, paneEpoch: PANE_EPOCH }]);
  }

  async connect(): Promise<void> {}
  disconnect(): void {}
  requestSnapshot(): void {}
  async setWindowStyle(): Promise<void> {}

  getCurrentSnapshot(): StateSnapshotPayload {
    return paneSnapshot(this.deviceId);
  }

  getServerEpoch(): Uint8Array {
    return SERVER_EPOCH;
  }

  getPaneIdentity(paneId: string) {
    return paneId === PANE_ID ? { paneId, paneEpoch: PANE_EPOCH } : null;
  }

  getMetadataSnapshot() {
    return {
      metadataEpoch: new Uint8Array(16).fill(0x44),
      revision: 1n,
      records: [
        {
          key: {
            deviceId: this.deviceId,
            serverEpoch: SERVER_EPOCH,
            entityKind: wsBorsh.SOURCE_ENTITY_PANE,
            nativeId: PANE_ID,
          },
          parent: null,
          fields: [
            { field: wsBorsh.SOURCE_FIELD_TITLE, value: { String: 'shell' } },
            { field: wsBorsh.SOURCE_FIELD_PANE_EPOCH, value: { Bytes16: PANE_EPOCH } },
          ],
        },
      ],
    };
  }

  attachPaneConsumer(callbacks: PaneRetentionConsumerCallbacks) {
    this.openConsumers += 1;
    const lease = this.retention.attachConsumer(callbacks);
    const close = lease.close.bind(lease);
    lease.close = () => {
      this.openConsumers -= 1;
      close();
    };
    return lease;
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readPaneHistory(): Promise<null> {
    return null;
  }

  async captureCanonicalScreen(): Promise<null> {
    return null;
  }

  sendInputBytes(): void {}
  resizePane(): void {}

  /** 产出一行 SEQ_n 探针；只有订阅被接受的会话才会收到。 */
  emit(): number {
    this.emitted += 1;
    this.retention.ingest(PANE_ID, PANE_EPOCH, encoder.encode(`SEQ_${this.emitted}\n`));
    return this.emitted;
  }
}

function runtimeDeps(runtime: FailoverPaneRuntime) {
  return {
    acquireRuntime: async () => runtime as unknown as DeviceSessionRuntime,
    releaseRuntime: async () => {},
    loadDeviceTreeOrder: (deviceId: string) => ({ deviceId, windows: [], panes: {} }),
    saveWindowOrder: () => {},
    savePaneOrder: () => {},
  };
}

function encodeHello(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'stream-failover',
    clientVersion: '1.1.23',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1);
}

function encodeDeviceConnect(deviceId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
    seq
  );
}

function encodeSubscribe(deviceId: string, paneId: string, seq = 3): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_COMMAND,
    wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [
          {
            pane: { deviceId, serverEpoch: SERVER_EPOCH, paneId },
            cursor: null,
          },
        ],
        hotPanes: [],
      },
    }),
    seq
  );
}

function canonicalEvents(frames: Uint8Array[]): wsBorsh.CanonicalEvent[] {
  return frames.flatMap((frame) => {
    try {
      const env = wsBorsh.decodeEnvelope(frame);
      if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) return [];
      return [wsBorsh.decodeCanonicalEventPayload(env.payload).event];
    } catch {
      return [];
    }
  });
}

function paneDataEvents(frames: Uint8Array[]) {
  return canonicalEvents(frames).flatMap((event) => ('PaneData' in event ? [event.PaneData] : []));
}

function subscriptionApplied(frames: Uint8Array[]) {
  return canonicalEvents(frames).flatMap((event) =>
    'SubscriptionApplied' in event ? [event.SubscriptionApplied] : []
  );
}

/**
 * 按到达顺序核对 pane 字节流：seqStart 必须接上一帧的 seqEnd。
 * 接不上的地方，若前面没有 SourceGap 就是静默丢数据；往回走就是重复投递。
 */
function walkPaneStream(events: wsBorsh.CanonicalEvent[]): {
  first: bigint | null;
  silentGaps: string[];
  duplicates: string[];
  announcedGaps: number;
} {
  let expected: bigint | null = null;
  let first: bigint | null = null;
  let pendingGap = false;
  let announcedGaps = 0;
  const silentGaps: string[] = [];
  const duplicates: string[] = [];
  for (const event of events) {
    if ('SourceGap' in event) {
      pendingGap = true;
      announcedGaps += 1;
      continue;
    }
    if (!('PaneData' in event)) continue;
    const data = event.PaneData;
    if (first === null) first = data.seqStart;
    if (expected !== null && data.seqStart !== expected) {
      if (data.seqStart < expected) duplicates.push(`${expected}->${data.seqStart}`);
      else if (!pendingGap) silentGaps.push(`${expected}->${data.seqStart}`);
    }
    pendingGap = false;
    expected = data.seqEnd;
  }
  return { first, silentGaps, duplicates, announcedGaps };
}

function seqNumbers(frames: Uint8Array[]): number[] {
  return paneDataEvents(frames).flatMap((data) =>
    [...new TextDecoder().decode(data.data).matchAll(/SEQ_(\d+)/g)].map((m) => Number(m[1]))
  );
}

describe('stream failover integration', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('pane stream over dc stays contiguous at entry WS after the dc link dies', async () => {
    const fake = createFakeNativeModule();
    const loadNative = async () => fake.module;

    const runtimeB = new FailoverPaneRuntime();
    fixtures.push({ close: () => runtimeB.retention.dispose() });
    const wsServerA = new WebSocketServer();
    const wsServerB = new WebSocketServer({ deps: runtimeDeps(runtimeB) });

    const h = await bootRelayMeshHarness();
    fixtures.push({ close: () => {}, stop: () => h.stop() });
    const tenant = await h.createTenant('alice', {
      loadNative,
      peerPort: 39001,
      stunServers: ['stun:stun.example:3478'],
      gatewayFactory: (db) => fakeGateway(db, wsServerA),
    });
    await tenant.enroll();
    const meshA = tenant.owner.mesh;
    const boot: BootUser = {
      userId: tenant.userId,
      rootKey: tenant.rootKey,
      rootPublicKey: tenant.rootPublicKey,
      rootEpoch: tenant.rootEpoch,
    };
    const meshB = (
      await tenant.joinNode('node-b', {
        loadNative,
        peerPort: 39002,
        stunServers: ['stun:stun.example:3478'],
        gatewayFactory: (db) => fakeGateway(db, wsServerB),
      })
    ).mesh;

    await waitUntil(
      () => meshA.lastNodeList?.nodes.some((n) => n.id === meshB.nodeId && n.online) === true,
      8_000
    );
    await meshA.peers.getLink(meshB.nodeId);
    await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'dc', 8_000);
    expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');

    const sid = await loginSelf(meshA, boot);
    const cookie = selfCookie(sid);
    const remote = await loginRemote(meshA, meshB, boot, cookie);
    expect(remote.status).toBe(200);
    const remoteSid = sidFromResponse(remote, meshB.nodeId);
    const jar = jarFor(sid, meshB.nodeId, remoteSid);
    let upgradeData: { kind?: string; token?: string } | undefined;
    const upgrade = await meshA.handleRequest(
      new Request(`http://entry/n/${meshB.nodeId}/ws`, {
        headers: { cookie: jar },
      }),
      {
        upgrade(_req, opts) {
          upgradeData = opts?.data as typeof upgradeData;
          return true;
        },
      }
    );
    expect(upgrade).toBeUndefined();
    expect(upgradeData?.kind).toBe(MESH_FORWARD_WS_KIND);

    const entryFrames: Uint8Array[] = [];
    let browserClosed = false;
    const entryWs = {
      data: upgradeData ?? { kind: MESH_FORWARD_WS_KIND },
      send(frame: Uint8Array) {
        entryFrames.push(frame.slice());
        return frame.byteLength;
      },
      close() {
        browserClosed = true;
      },
    } as MeshServerWebSocket;
    meshA.websocket.open(entryWs);
    meshA.websocket.message(entryWs, Buffer.from(encodeHello()));
    meshA.websocket.message(entryWs, Buffer.from(encodeDeviceConnect(DEVICE_ID, 2)));
    meshA.websocket.message(entryWs, Buffer.from(encodeSubscribe(DEVICE_ID, PANE_ID)));

    await waitUntil(
      () => [...wsServerB.connectedClients].some((c) => c.borshState.negotiated),
      3_000
    );
    // 订阅被接受（设备已挂载、pane 身份对得上）才开始产出。
    await waitUntil(() => runtimeB.openConsumers > 0, 5_000);
    await waitUntil(() => subscriptionApplied(entryFrames).length > 0, 5_000);
    const firstApplied = subscriptionApplied(entryFrames)[0];
    expect(firstApplied?.rejected).toEqual([]);
    expect(firstApplied?.activePanes.map((row) => row.paneId)).toEqual([PANE_ID]);

    const logs: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      logs.push(String(args[0]));
      origInfo.apply(console, args);
    };

    // 输出只灌进节点侧的保留区，由 canonical feed 决定谁能收到、从哪个游标续。
    const timer = setInterval(() => {
      runtimeB.emit();
    }, 20);

    try {
      await waitUntil(() => seqNumbers(entryFrames).length >= 8, 5_000);
      const beforeKill = seqNumbers(entryFrames);
      const cursorBeforeKill = paneDataEvents(entryFrames).at(-1)?.seqEnd ?? 0n;
      // 机器繁忙时 dc 可能短暂退化，等它回来再断，保证断的确实是 dc 这条路。
      await waitUntil(() => meshA.peers.transportOf(meshB.nodeId) === 'dc', 8_000);
      expect(meshA.peers.transportOf(meshB.nodeId)).toBe('dc');
      meshA.peers.getLive(meshB.nodeId)?.close('drop-dc');
      meshB.peers.getLive(meshA.nodeId)?.close('drop-dc');

      await waitUntil(
        () => logs.some((line) => line.includes('[mesh][stream] failover stream=')),
        25_000
      );
      await waitUntil(() => seqNumbers(entryFrames).length >= beforeKill.length + 8, 10_000);
      expect(browserClosed).toBe(false);

      // 切换后的订阅同样要被接受，而且续在切换前收到的最后一个字节上。
      const applied = subscriptionApplied(entryFrames);
      expect(applied.length).toBeGreaterThanOrEqual(2);
      expect(applied.at(-1)?.rejected).toEqual([]);
      expect(applied.at(-1)?.activePanes.map((row) => row.paneId)).toEqual([PANE_ID]);

      // 字节流不许重复，也不许静默丢：每帧的 seqStart 要接在上一帧的 seqEnd 上，
      // 除非节点先明确报了 gap（切换时间超过保留窗口时的合法结果）。
      const stream = walkPaneStream(canonicalEvents(entryFrames));
      expect(stream.first).toBe(0n);
      expect(stream.silentGaps).toEqual([]);
      expect(stream.duplicates).toEqual([]);

      // 没报 gap 就必须严格续在切换前收到的最后一个字节上。
      if (stream.announcedGaps === 0) {
        const resumeAt = paneDataEvents(entryFrames).find(
          (data) => data.seqStart >= cursorBeforeKill
        );
        expect(resumeAt?.seqStart).toBe(cursorBeforeKill);
      }

      // SEQ_n 探针严格递增、不重复；没报 gap 时还必须是 1,2,3,… 无缺口。
      const nums = seqNumbers(entryFrames);
      expect(nums[0]).toBe(1);
      for (let i = 1; i < nums.length; i += 1) {
        expect(nums[i]).toBeGreaterThan(nums[i - 1] as number);
        if (stream.announcedGaps === 0) expect(nums[i]).toBe((nums[i - 1] ?? 0) + 1);
      }
      expect(logs.some((line) => /from=dc to=(relay|ws-secure|dc) resumed=1/.test(line))).toBe(
        true
      );
    } finally {
      clearInterval(timer);
      console.info = origInfo;
    }
  }, 45_000);
});
