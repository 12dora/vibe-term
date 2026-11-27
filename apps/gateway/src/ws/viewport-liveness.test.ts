import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { StateSnapshotPayload } from '@vibeterm/shared';
import { wsBorsh } from '@vibeterm/shared';
import {
  WS_CLOSE_IDLE_TIMEOUT,
  WS_CLOSE_IDLE_TIMEOUT_REASON,
  isTerminalStreamCloseCode,
} from '../mesh/stream-close-code';
import { sessionStateStore } from './borsh/session-state';
import { WebSocketServer } from './index';
import {
  type BorshTestWs,
  createFakeCarrier,
  createGatewaySession,
  setupConnectionEntry,
} from './test-helpers';
import {
  SESSION_IDLE_TIMEOUT_MS,
  VIEWPORT_CLAIM_STALE_MS,
  VIEWPORT_LIVENESS_SWEEP_MS,
} from './viewport-liveness';

let sizeEpoch = 0n;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function snapshot(width = 80, height = 24): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'VibeTerm',
      windows: [
        {
          id: '@1',
          name: 'w1',
          index: 0,
          active: true,
          panes: [{ id: '%0', windowId: '@1', index: 0, title: 't', active: true, width, height }],
        },
      ],
    },
  };
}

function setup(options: { canonicalOnly?: 'large' } = {}) {
  const clock = { now: 0 };
  const resizePaneCalls: Array<[string, number, number]> = [];
  const server = new WebSocketServer({
    deps: {
      now: () => clock.now,
      releaseRuntime: () => {},
      loadDeviceTreeOrder: (deviceId: string) => ({ deviceId, windows: [], panes: {} }),
    },
  });
  const large = createGatewaySession({ id: 'sess-large' });
  const small = createGatewaySession({ id: 'sess-small' });
  server.handleOpen(large);
  server.handleOpen(small);
  // 等同直连浏览器 WS 的会话：可被空闲回收。
  large.idleClosable = true;
  small.idleClosable = true;
  const entry = setupConnectionEntry(server, {
    deviceId: 'device-a',
    runtime: {
      resizePane(paneId: string, cols: number, rows: number) {
        resizePaneCalls.push([paneId, cols, rows]);
      },
      resizeWindow() {},
      requestSnapshot() {},
    },
    clients: new Set(options.canonicalOnly === 'large' ? [small] : [large, small]),
    lastSnapshot: snapshot(),
  });
  if (options.canonicalOnly === 'large') entry.canonicalClients = new Set([large]);
  cleanups.push(() => {
    server.closeAll();
    sessionStateStore.delete(large);
    sessionStateStore.delete(small);
  });
  return { server, clock, resizePaneCalls, large, small, entry };
}

function resize(
  server: WebSocketServer,
  session: BorshTestWs,
  cols: number,
  rows: number,
  reason: GeometryReasonValue = wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE
): void {
  if (reason === wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE) sizeEpoch += 1n;
  server.handleCanonicalResize(session, {
    deviceId: 'device-a',
    paneId: '%0',
    cols,
    rows,
    reason,
    sizeEpoch: sizeEpoch > 0n ? sizeEpoch : 1n,
  });
}

type GeometryReasonValue =
  | typeof wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE
  | typeof wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND;

function pingFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, { nonce: 1, timeMs: 1n });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, 1);
}

function ping(server: WebSocketServer, session: BorshTestWs): void {
  session.borshState.negotiated = true;
  server.handleDecodedEnvelope(session, wsBorsh.decodeEnvelope(pingFrame()));
}

function viewportFrame(visible: boolean, cols = 80, rows = 24): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermViewportSchema, {
    deviceId: 'device-a',
    paneId: '%0',
    cols,
    rows,
    visible,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_VIEWPORT, payload, 2);
}

/** 入站帧的处理是异步的：复活后的重算排在帧处理完成之后。 */
async function settle(): Promise<void> {
  await Bun.sleep(0);
}

function policyCount(session: BorshTestWs): number {
  return session.sent.filter(
    (bytes) => wsBorsh.decodeEnvelope(bytes).kind === wsBorsh.KIND_TERM_VIEWPORT_POLICY
  ).length;
}

function makeStale(server: WebSocketServer, clock: { now: number }, live: BorshTestWs): void {
  advance(server, clock, VIEWPORT_CLAIM_STALE_MS + VIEWPORT_LIVENESS_SWEEP_MS, () =>
    ping(server, live)
  );
}

function lastPolicy(session: BorshTestWs) {
  return session.sent
    .flatMap((bytes) => {
      const envelope = wsBorsh.decodeEnvelope(bytes);
      if (envelope.kind !== wsBorsh.KIND_TERM_VIEWPORT_POLICY) return [];
      return [wsBorsh.decodePayload(wsBorsh.schema.TermViewportPolicySchema, envelope.payload)];
    })
    .at(-1);
}

function closeCalls(session: BorshTestWs) {
  return (session.primary as unknown as { closeCalls: Array<{ code: number; reason: string }> })
    .closeCalls;
}

/** 推进假时钟，每过一个巡检周期跑一次 sweep；`beforeSweep` 在每次巡检前执行（模拟持续心跳）。 */
function advance(
  server: WebSocketServer,
  clock: { now: number },
  ms: number,
  beforeSweep?: () => void
): void {
  const until = clock.now + ms;
  while (clock.now < until) {
    clock.now = Math.min(until, clock.now + VIEWPORT_LIVENESS_SWEEP_MS);
    beforeSweep?.();
    server.viewportLiveness.sweep();
  }
}

describe('viewport liveness', () => {
  test('stale smaller claimant: sweep hands ownership to the live larger claimant', () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    expect(lastPolicy(small)).toMatchObject({ owner: true, cols: 80, rows: 24 });
    resizePaneCalls.length = 0;

    advance(server, clock, VIEWPORT_CLAIM_STALE_MS + VIEWPORT_LIVENESS_SWEEP_MS, () =>
      ping(server, large)
    );

    expect(resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
    expect(lastPolicy(small)).toMatchObject({ owner: false, cols: 160, rows: 48 });
    expect(small.viewportClaims.get('device-a/@1')).toMatchObject({ visible: true, cols: 80 });

    resizePaneCalls.length = 0;
    advance(server, clock, VIEWPORT_LIVENESS_SWEEP_MS * 3, () => ping(server, large));
    expect(resizePaneCalls).toEqual([]);
  });

  test('stale session sending a frame again re-enters arbitration and wins back', async () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    makeStale(server, clock, large);
    expect(lastPolicy(large)?.owner).toBe(true);
    resizePaneCalls.length = 0;

    ping(server, small);
    await settle();

    expect(resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(lastPolicy(small)).toMatchObject({ owner: true, cols: 80, rows: 24 });
    expect(lastPolicy(large)).toMatchObject({ owner: false, cols: 80, rows: 24 });
  });

  test('revived session retracting its claim causes no intermediate resize to the old size', async () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    makeStale(server, clock, large);
    resizePaneCalls.length = 0;
    const largePolicies = policyCount(large);

    server.handleDecodedEnvelope(small, wsBorsh.decodeEnvelope(viewportFrame(false)));
    await settle();

    expect(resizePaneCalls).toEqual([]);
    expect(policyCount(large)).toBe(largePolicies);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
    expect(small.viewportClaims.get('device-a/@1')?.visible).toBe(false);
    expect(small.reviveRecomputePending).toBe(false);
  });

  test('revival recompute waits for the reassembled message of a chunked frame', async () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    makeStale(server, clock, large);
    resizePaneCalls.length = 0;

    const frame = viewportFrame(false);
    const payload = wsBorsh.decodeEnvelope(frame).payload;
    const half = Math.ceil(payload.byteLength / 2);
    const chunk = (index: number, data: Uint8Array) =>
      wsBorsh.decodeEnvelope(
        wsBorsh.encodeChunk(
          {
            chunkStreamId: 9,
            totalChunks: 2,
            chunkIndex: index,
            originalKind: wsBorsh.KIND_TERM_VIEWPORT,
            originalSeq: 2,
            data,
          },
          3 + index
        )
      );
    server.handleDecodedEnvelope(small, chunk(0, payload.slice(0, half)));
    await settle();
    expect(resizePaneCalls).toEqual([]);
    expect(small.reviveRecomputePending).toBe(true);

    server.handleDecodedEnvelope(small, chunk(1, payload.slice(half)));
    await settle();

    expect(resizePaneCalls).toEqual([]);
    expect(small.reviveRecomputePending).toBe(false);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
  });

  test('revival survives an aborted chunk stream: the next complete message recomputes', async () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    makeStale(server, clock, large);
    await settle();
    resizePaneCalls.length = 0;

    const payload = wsBorsh.decodeEnvelope(viewportFrame(false)).payload;
    server.handleDecodedEnvelope(
      small,
      wsBorsh.decodeEnvelope(
        wsBorsh.encodeChunk(
          {
            chunkStreamId: 11,
            totalChunks: 2,
            chunkIndex: 0,
            originalKind: wsBorsh.KIND_TERM_VIEWPORT,
            originalSeq: 2,
            data: payload.slice(0, 2),
          },
          3
        )
      )
    );
    await settle();
    expect(small.reviveRecomputePending).toBe(true);
    expect(resizePaneCalls).toEqual([]);

    ping(server, small);
    await settle();
    expect(small.reviveRecomputePending).toBe(false);
    expect(resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(lastPolicy(small)).toMatchObject({ owner: true, cols: 80, rows: 24 });
  });

  test('never-pinged session is neither excluded from arbitration nor reaped', () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    ping(server, large);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    resizePaneCalls.length = 0;

    advance(server, clock, SESSION_IDLE_TIMEOUT_MS * 2, () => ping(server, large));

    expect(resizePaneCalls).toEqual([]);
    expect(lastPolicy(small)).toMatchObject({ owner: true, cols: 80, rows: 24 });
    expect(small.closed).toBe(false);
    expect(closeCalls(small)).toEqual([]);
  });

  test('reaper closes a heartbeat-proven idle session through the normal close path', () => {
    const { server, clock, resizePaneCalls, large, small, entry } = setup();
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    resizePaneCalls.length = 0;
    clock.now = SESSION_IDLE_TIMEOUT_MS + 1;

    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((message: unknown) => {
      if (typeof message === 'string') logs.push(message);
    });
    try {
      server.viewportLiveness.sweep();
    } finally {
      logSpy.mockRestore();
    }

    expect(small.closed).toBe(true);
    expect(closeCalls(small)).toEqual([
      { code: WS_CLOSE_IDLE_TIMEOUT, reason: WS_CLOSE_IDLE_TIMEOUT_REASON },
    ]);
    expect(small.viewportClaims.size).toBe(0);
    expect(entry.clients.has(small)).toBe(false);
    expect(server.connectedClients.has(small)).toBe(false);
    expect(resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
    expect(logs.some((line) => line.includes('[ws] client idle timeout session=sess-small'))).toBe(
      true
    );
    expect(large.closed).toBe(false);
  });

  test('a session that keeps pinging is never reaped', () => {
    const { server, clock, large } = setup();
    ping(server, large);
    resize(server, large, 160, 48);

    advance(server, clock, SESSION_IDLE_TIMEOUT_MS * 3, () => {
      if (clock.now % 15_000 === 0) ping(server, large);
    });

    expect(large.closed).toBe(false);
    expect(closeCalls(large)).toEqual([]);
    expect(lastPolicy(large)?.owner).toBe(true);
  });

  test('resend re-applies even when lastApplied equals the winner; change still dedupes', () => {
    const { server, resizePaneCalls, large, small, entry } = setup();
    entry.clients.delete(small);
    resize(server, large, 100, 30);
    expect(resizePaneCalls).toEqual([['%0', 100, 30]]);
    expect(entry.lastAppliedViewport?.get('@1')).toEqual({ cols: 100, rows: 30 });
    resizePaneCalls.length = 0;

    const pane = entry.lastSnapshot?.session?.windows[0]?.panes[0];
    if (!pane) throw new Error('pane missing');
    pane.width = 52;
    pane.height = 49;
    resize(server, large, 100, 30, wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND);
    expect(resizePaneCalls).toEqual([['%0', 100, 30]]);

    resize(server, large, 100, 30, wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND);
    expect(resizePaneCalls).toEqual([
      ['%0', 100, 30],
      ['%0', 100, 30],
    ]);

    resize(server, large, 100, 30);
    expect(resizePaneCalls).toHaveLength(2);
  });

  test('forced resend that changes nothing is not broadcast to other claimants', () => {
    const { server, resizePaneCalls, large, small } = setup();
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    resizePaneCalls.length = 0;
    const largePolicies = policyCount(large);
    const smallPolicies = policyCount(small);

    resize(server, small, 80, 24, wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND);
    resize(server, large, 160, 48, wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND);

    expect(resizePaneCalls).toEqual([
      ['%0', 80, 24],
      ['%0', 80, 24],
    ]);
    expect(policyCount(large)).toBe(largePolicies);
    expect(policyCount(small)).toBe(smallPolicies);
  });

  test('claimant only in canonicalClients is arbitrated when another session drops', () => {
    const { server, resizePaneCalls, large, small, entry } = setup({ canonicalOnly: 'large' });
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    expect(lastPolicy(large)).toMatchObject({ owner: false, cols: 80, rows: 24 });
    resizePaneCalls.length = 0;

    entry.clients.delete(small);
    server.dropViewportClaims(small);

    expect(resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
  });

  test('sweep timer starts with the first session and is cleared by closeAll', () => {
    const { server } = setup();
    expect(server.viewportLiveness.running).toBe(true);
    server.closeAll();
    expect(server.viewportLiveness.running).toBe(false);
  });

  test('sweep timer stops once the last session closes', () => {
    const { server, large, small } = setup();
    server.closeSession(large, 1000, 'test');
    expect(server.viewportLiveness.running).toBe(true);
    server.closeSession(small, 1000, 'test');
    expect(server.viewportLiveness.running).toBe(false);
  });

  test('session never declared idle-closable is excluded when stale but not reaped', () => {
    const { server, clock, resizePaneCalls, large, small } = setup();
    small.idleClosable = false;
    ping(server, small);
    resize(server, large, 160, 48);
    resize(server, small, 80, 24);
    resizePaneCalls.length = 0;

    advance(server, clock, SESSION_IDLE_TIMEOUT_MS * 2);

    expect(small.closed).toBe(false);
    expect(closeCalls(small)).toEqual([]);
    expect(resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({ owner: true, cols: 160, rows: 48 });
  });

  test('idle close is a terminal stream close so the entry hands it to the browser', () => {
    expect(isTerminalStreamCloseCode(WS_CLOSE_IDLE_TIMEOUT)).toBe(true);
  });
});

describe('viewport liveness stamping through real inbound entry points', () => {
  function server(clock: { now: number }) {
    const ws = new WebSocketServer({ deps: { now: () => clock.now } });
    cleanups.push(() => ws.closeAll());
    return ws;
  }

  test('direct browser WS: handleMessage stamps and marks heartbeat; session is idle-closable', () => {
    const clock = { now: 1_000 };
    const ws = server(clock);
    const carrier = createFakeCarrier();
    const session = createGatewaySession({ carrier });
    session.idleClosable = true;
    ws.handleOpen(session);
    session.borshState.negotiated = true;
    clock.now = 5_000;

    ws.handleMessage({ data: { session, carrier } } as never, Buffer.from(pingFrame()));

    expect(session.lastInboundAt).toBe(5_000);
    expect(session.heartbeatExpected).toBe(true);
    sessionStateStore.delete(session);
  });

  test('stream session: onDecodedEnvelope and onMessage both stamp; mesh flag decides reaping', () => {
    const clock = { now: 1_000 };
    const ws = server(clock);
    const meshCarrier = createFakeCarrier();
    meshCarrier.logContext = { kind: 'mesh_link_stream' };
    const legacy = ws.attachStreamSession(meshCarrier);
    const declared = ws.attachStreamSession(
      Object.assign(createFakeCarrier(), { logContext: { kind: 'mesh_link_stream' as const } }),
      { idleCloseSupported: true }
    );
    const plain = ws.attachStreamSession(createFakeCarrier());
    expect(legacy.session.idleClosable).toBe(false);
    expect(declared.session.idleClosable).toBe(true);
    expect(plain.session.idleClosable).toBe(true);

    legacy.session.borshState.negotiated = true;
    clock.now = 7_000;
    legacy.onDecodedEnvelope(wsBorsh.decodeEnvelope(pingFrame()));
    expect(legacy.session.lastInboundAt).toBe(7_000);
    expect(legacy.session.heartbeatExpected).toBe(true);
    clock.now = 9_000;
    legacy.onMessage(pingFrame());
    expect(legacy.session.lastInboundAt).toBe(9_000);
  });

  test('webrtc direct carrier: deliverRtcInbound stamps the owning session', () => {
    const clock = { now: 1_000 };
    const ws = server(clock);
    const primary = createFakeCarrier();
    const direct = createFakeCarrier();
    const session = createGatewaySession({ carrier: primary });
    ws.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.borshState.negotiated = true;
    clock.now = 11_000;

    ws.deliverRtcInbound(session, pingFrame(), direct);

    expect(session.lastInboundAt).toBe(11_000);
    expect(session.heartbeatExpected).toBe(true);
    ws.closeSession(session, 1000, 'test');
  });
});
