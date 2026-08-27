// `/mesh/ws` 帧解码与重连退避。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';
import {
  type EnrollRedeemedPayload,
  KIND_ENROLL_REDEEMED,
  MeshEventSource,
  type MeshSocketLike,
  type NodeEventPayload,
  type RtcSignalPayload,
  decodeMeshFrame,
  encodeRtcSignal,
  meshWsUrl,
} from './mesh-events';

function nodeEventFrame(payload: {
  nodeId: string;
  status: number;
  reach: string | null;
  inventory: string | null;
}): Uint8Array {
  const body = wsBorsh.encodePayload(wsBorsh.schema.NodeEventSchema, payload);
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_NODE_EVENT, body, 1);
}

function enrollRedeemedFrame(payload: {
  enrollPk: Uint8Array;
  certificate: Uint8Array;
  certSig: Uint8Array;
  nodeId: string;
}): Uint8Array {
  const body = wsBorsh.encodePayload(wsBorsh.schema.EnrollRedeemedSchema, payload);
  return wsBorsh.encodeEnvelope(KIND_ENROLL_REDEEMED, body, 1);
}

class FakeSocket implements MeshSocketLike {
  binaryType = '';
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(code?: number): void {
    this.onclose?.(code === undefined ? {} : { code });
  }
}

describe('decodeMeshFrame', () => {
  test('NODE_EVENT：状态枚举、reach、inventory JSON 都解出来', () => {
    const frame = nodeEventFrame({
      nodeId: 'node-a',
      status: wsBorsh.NODE_EVENT_STATUS_ONLINE,
      reach: 'relay',
      inventory: JSON.stringify({ version: '1.0.0' }),
    });
    expect(decodeMeshFrame(frame)).toEqual({
      kind: 'node-event',
      payload: {
        nodeId: 'node-a',
        status: 'online',
        reach: 'relay',
        inventory: { version: '1.0.0' },
      } satisfies NodeEventPayload,
    });
  });

  test('offline / revoked 枚举映射', () => {
    const offline = decodeMeshFrame(
      nodeEventFrame({
        nodeId: 'a',
        status: wsBorsh.NODE_EVENT_STATUS_OFFLINE,
        reach: null,
        inventory: null,
      })
    );
    const revoked = decodeMeshFrame(
      nodeEventFrame({
        nodeId: 'a',
        status: wsBorsh.NODE_EVENT_STATUS_REVOKED,
        reach: null,
        inventory: null,
      })
    );
    expect(offline?.kind === 'node-event' && offline.payload.status).toBe('offline');
    expect(revoked?.kind === 'node-event' && revoked.payload.status).toBe('revoked');
  });

  test('inventory 不是合法 JSON 时保留原串', () => {
    const frame = nodeEventFrame({
      nodeId: 'a',
      status: 0,
      reach: 'lan',
      inventory: 'not json',
    });
    const decoded = decodeMeshFrame(frame);
    expect(decoded?.kind === 'node-event' && decoded.payload.inventory).toBe('not json');
  });

  test('RTC_SIGNAL 往返', () => {
    const signal: RtcSignalPayload = {
      rtcSession: 'sess-1',
      from: 'browser',
      to: 'node-b',
      sdp: 'v=0',
      candidate: null,
    };
    expect(decodeMeshFrame(encodeRtcSignal(signal))).toEqual({
      kind: 'rtc-signal',
      payload: signal,
    });
  });

  test('非 mesh kind 与畸形帧返回 null（不抛）', () => {
    const other = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, new Uint8Array(0), 0);
    expect(decodeMeshFrame(other)).toBeNull();
    expect(decodeMeshFrame(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test('未知 status 枚举整帧作废，而不是当成 online', () => {
    const frame = nodeEventFrame({ nodeId: 'a', status: 99, reach: 'lan', inventory: null });
    expect(decodeMeshFrame(frame)).toBeNull();
  });

  test('未知 RTC_SIGNAL.from 整帧作废，而不是当成 browser', () => {
    const body = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
      rtcSession: 's',
      from: 42,
      to: 'x',
      sdp: null,
      candidate: null,
    });
    expect(decodeMeshFrame(wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, body, 0))).toBeNull();
  });

  test('协议版本不符整帧作废', () => {
    const body = wsBorsh.encodePayload(wsBorsh.schema.NodeEventSchema, {
      nodeId: 'a',
      status: 0,
      reach: null,
      inventory: null,
    });
    const frame = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_NODE_EVENT,
      body,
      0,
      0,
      wsBorsh.CURRENT_VERSION + 1
    );
    expect(decodeMeshFrame(frame)).toBeNull();
  });

  test('ENROLL_REDEEMED 解出 hub 转发的证书（字节转 base64url）', () => {
    const enrollPk = new Uint8Array(32).fill(3);
    const certificate = new Uint8Array(20).fill(4);
    const certSig = new Uint8Array(64).fill(5);
    const frame = enrollRedeemedFrame({
      enrollPk,
      certificate,
      certSig,
      nodeId: 'a'.repeat(32),
    });
    expect(decodeMeshFrame(frame)).toEqual({
      kind: 'enroll-redeemed',
      payload: {
        enrollPk: encodeBase64url(enrollPk),
        certificate: encodeBase64url(certificate),
        certSig: encodeBase64url(certSig),
        nodeId: 'a'.repeat(32),
      } satisfies EnrollRedeemedPayload,
    });
  });

  test('ENROLL_REDEEMED 缺证书 / 签名长度不对时作废', () => {
    expect(
      decodeMeshFrame(
        enrollRedeemedFrame({
          enrollPk: new Uint8Array(32).fill(3),
          certificate: new Uint8Array(0),
          certSig: new Uint8Array(64),
          nodeId: 'x',
        })
      )
    ).toBeNull();
    expect(
      decodeMeshFrame(
        enrollRedeemedFrame({
          enrollPk: new Uint8Array(32).fill(3),
          certificate: new Uint8Array(20),
          certSig: new Uint8Array(10),
          nodeId: 'x',
        })
      )
    ).toBeNull();
  });
});

describe('meshWsUrl', () => {
  test('https → wss，始终打 entry 自身且不带 /n 前缀', () => {
    expect(meshWsUrl({ protocol: 'https:', host: 'h.example:9663' })).toBe(
      'wss://h.example:9663/mesh/ws'
    );
    expect(meshWsUrl({ protocol: 'http:', host: 'localhost:19663' })).toBe(
      'ws://localhost:19663/mesh/ws'
    );
  });
});

describe('MeshEventSource', () => {
  function harness(options: { random?: () => number } = {}) {
    const sockets: FakeSocket[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const unauthorized: number[] = [];
    const clock = { now: 1_000_000 };
    const source = new MeshEventSource({
      url: 'ws://x/mesh/ws',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      baseDelayMs: 100,
      maxDelayMs: 1000,
      stableAfterMs: 10_000,
      // 抖动因子固定成 1 → 退避取上界，断言可确定。
      random: options.random ?? (() => 1),
      nowFn: () => clock.now,
      onUnauthorized: () => unauthorized.push(1),
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutFn: () => undefined,
    });
    return { source, sockets, timers, unauthorized, clock };
  }

  test('NODE_EVENT 多播给全部订阅者，注销后不再收到', () => {
    const { source, sockets } = harness();
    const seen: NodeEventPayload[] = [];
    const unsubscribe = source.onNodeEvent((event) => seen.push(event));
    source.start();
    sockets[0].open();
    expect(source.connected).toBe(true);

    sockets[0].emit(
      nodeEventFrame({ nodeId: 'a', status: 0, reach: 'lan', inventory: null }).buffer
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].nodeId).toBe('a');

    unsubscribe();
    sockets[0].emit(nodeEventFrame({ nodeId: 'b', status: 0, reach: 'lan', inventory: null }));
    expect(seen).toHaveLength(1);
    source.stop();
  });

  test('RTC_SIGNAL 只给注册的 handler；未注册时丢弃', () => {
    const { source, sockets } = harness();
    source.start();
    sockets[0].open();
    const signal: RtcSignalPayload = {
      rtcSession: 's',
      from: 'node',
      to: 'browser',
      sdp: null,
      candidate: 'cand',
    };
    sockets[0].emit(encodeRtcSignal(signal));

    const got: RtcSignalPayload[] = [];
    const off = source.setRtcSignalHandler((value) => got.push(value));
    sockets[0].emit(encodeRtcSignal(signal));
    expect(got).toEqual([signal]);
    off();
    sockets[0].emit(encodeRtcSignal(signal));
    expect(got).toHaveLength(1);
    source.stop();
  });

  test('断线后按指数退避重连；只有稳定连接才重置退避', () => {
    const { source, sockets, timers, clock } = harness();
    source.start();
    sockets[0].open();

    sockets[0].drop();
    expect(source.connected).toBe(false);
    expect(timers.at(-1)?.ms).toBe(100);
    timers.at(-1)?.fn();
    expect(sockets).toHaveLength(2);

    // 没连上就又断：退避翻倍
    sockets[1].drop();
    expect(timers.at(-1)?.ms).toBe(200);
    timers.at(-1)?.fn();
    sockets[2].drop();
    expect(timers.at(-1)?.ms).toBe(400);
    timers.at(-1)?.fn();

    // open 之后立刻被关（4401 之外的原因）：退避不重置，继续翻倍。
    sockets[3].open();
    sockets[3].drop();
    expect(timers.at(-1)?.ms).toBe(800);
    timers.at(-1)?.fn();

    // 稳定 10 s 后再断才重置。
    sockets[4].open();
    clock.now += 10_000;
    sockets[4].drop();
    expect(timers.at(-1)?.ms).toBe(100);
    source.stop();
  });

  test('收到一帧合法数据即视为连接可用，重置退避', () => {
    const { source, sockets, timers } = harness();
    source.start();
    sockets[0].drop();
    timers.at(-1)?.fn();
    sockets[1].drop();
    expect(timers.at(-1)?.ms).toBe(200);
    timers.at(-1)?.fn();

    sockets[2].open();
    sockets[2].emit(nodeEventFrame({ nodeId: 'a', status: 0, reach: 'lan', inventory: null }));
    sockets[2].drop();
    expect(timers.at(-1)?.ms).toBe(100);
    source.stop();
  });

  test('4401：停止重连并派发一次全局未授权', () => {
    const { source, sockets, timers, unauthorized } = harness();
    source.start();
    sockets[0].open();
    sockets[0].drop(4401);
    expect(unauthorized).toHaveLength(1);
    expect(timers).toHaveLength(0);
    expect(source.unauthorized).toBe(true);
    expect(source.connected).toBe(false);
  });

  test('退避有上限，且带 [0.5,1] 抖动', () => {
    const { source } = harness();
    expect(source.retryDelay(1)).toBe(100);
    expect(source.retryDelay(4)).toBe(800);
    expect(source.retryDelay(10)).toBe(1000);

    const jittered = harness({ random: () => 0 }).source;
    expect(jittered.retryDelay(1)).toBe(50);
    expect(jittered.retryDelay(10)).toBe(500);
  });

  test('stop 后不再重连', () => {
    const { source, sockets, timers } = harness();
    source.start();
    sockets[0].open();
    source.stop();
    expect(sockets[0].closed).toBe(true);
    expect(timers).toHaveLength(0);
  });

  test('sendRtcSignal 未连上时返回 false', () => {
    const { source, sockets } = harness();
    expect(
      source.sendRtcSignal({
        rtcSession: 's',
        from: 'browser',
        to: 'n',
        sdp: null,
        candidate: null,
      })
    ).toBe(false);
    source.start();
    sockets[0].open();
    expect(
      source.sendRtcSignal({
        rtcSession: 's',
        from: 'browser',
        to: 'n',
        sdp: null,
        candidate: null,
      })
    ).toBe(true);
    expect(sockets[0].sent).toHaveLength(1);
    source.stop();
  });
});
