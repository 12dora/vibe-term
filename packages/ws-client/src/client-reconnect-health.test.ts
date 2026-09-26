// primary WS 的重连节奏与存活判定（N5 审计 F2 / F3 / F10 的回归）：
// - READY 之后要保持一段时间才清零退避，握手后立刻被关的会话不会以 ~1 s 永远重连；
// - 宿主给的不可达退避是下一次重连的下限；关闭码 / 原因留给界面；
// - 直连活跃时 PING 超时先摘直连、在 primary 上补探，不直接拆健康的 primary。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { DirectCarrierLike } from './carrier-switch';
import { BorshWebSocketClient } from './client';
import { type FakeSocket, createFakeSocket, helloFrame } from './test-fakes';

interface ReconnectorProbe {
  options: { onSchedule?: (info: { delayMs: number }) => void };
  cancel(): void;
}

function reconnectorOf(client: BorshWebSocketClient): ReconnectorProbe {
  return (client as unknown as { reconnector: ReconnectorProbe }).reconnector;
}

function recordDelays(client: BorshWebSocketClient): number[] {
  const delays: number[] = [];
  const rc = reconnectorOf(client);
  const original = rc.options.onSchedule;
  rc.options.onSchedule = (info) => {
    delays.push(info.delayMs);
    original?.(info);
  };
  return delays;
}

function flappingClient(options: ConstructorParameters<typeof BorshWebSocketClient>[0] = {}) {
  const sockets: FakeSocket[] = [];
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 60_000,
    ...options,
  });
  const current = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error('no socket');
    return socket;
  };
  const reachReady = () => {
    current().open();
    current().deliver(helloFrame());
    expect(client.getState()).toBe('READY');
  };
  /** 退避定时器不真等：撤掉后立刻重连。 */
  const reconnectNow = () => {
    reconnectorOf(client).cancel();
    client.connect();
  };
  return { client, sockets, current, reachReady, reconnectNow };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastPingNonce(sent: ReadonlyArray<unknown>): number {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const frame = sent[i];
    if (!(frame instanceof Uint8Array)) continue;
    const envelope = wsBorsh.decodeEnvelope(frame);
    if (envelope.kind !== wsBorsh.KIND_PING) continue;
    return wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, envelope.payload).nonce;
  }
  throw new Error('no PING sent');
}

function pongFrame(nonce: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
    nonce,
    timeMs: BigInt(Date.now()),
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, payload, 1);
}

function switchFrame(epoch: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchSchema, {
    epoch,
    to: wsBorsh.CARRIER_SWITCH_TO_DIRECT,
    rtcSession: '',
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_CARRIER_SWITCH, payload, 0);
}

class FakeDirect implements DirectCarrierLike {
  readonly sent: Uint8Array[] = [];
  closed = false;
  private closeCb: (() => void) | null = null;
  send(bytes: Uint8Array): 'sent' | 'backpressure' | 'closed' {
    if (this.closed) return 'closed';
    this.sent.push(bytes);
    return 'sent';
  }
  onMessage(): void {}
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closed = true;
    this.closeCb?.();
  }
}

describe('primary 重连退避只在会话健康一段时间后清零（F2）', () => {
  test('每次 READY 后立刻被关（如 1011 failover-exhausted）：退避逐次翻倍，不再 ~1 s 永远重连', () => {
    const h = flappingClient();
    const delays = recordDelays(h.client);
    h.client.connect();
    for (let i = 0; i < 6; i += 1) {
      h.reachReady();
      h.current().simulateClose(1011, 'failover-exhausted');
      h.reconnectNow();
    }
    h.client.disconnect();
    expect(delays).toHaveLength(6);
    // 第 n 次的指数基数是 1000·2^(n-1)，抖动下限 0.5 倍
    expect(delays[2]).toBeGreaterThanOrEqual(2000);
    expect(delays[5]).toBeGreaterThanOrEqual(15_000);
  });

  test('READY 保持满 reconnectHealthyMs：退避清零并通知 onSessionHealthy', async () => {
    const h = flappingClient({ reconnectHealthyMs: 20 });
    const delays = recordDelays(h.client);
    let healthy = 0;
    h.client.onSessionHealthy(() => {
      healthy += 1;
    });
    h.client.connect();
    for (let i = 0; i < 3; i += 1) {
      h.reachReady();
      h.current().simulateClose();
      h.reconnectNow();
    }
    h.reachReady();
    await sleep(40);
    expect(healthy).toBe(1);
    h.current().simulateClose();
    h.client.disconnect();
    expect(delays[3]).toBeLessThanOrEqual(1000);
  });

  test('READY 不到 reconnectHealthyMs 就断：不算健康', async () => {
    const h = flappingClient({ reconnectHealthyMs: 30 });
    let healthy = 0;
    h.client.onSessionHealthy(() => {
      healthy += 1;
    });
    h.client.connect();
    h.reachReady();
    await sleep(5);
    h.current().simulateClose();
    await sleep(40);
    h.client.disconnect();
    expect(healthy).toBe(0);
  });

  test('宿主给的下限（该 node 的不可达退避）压住下一次重连', () => {
    const h = flappingClient({ reconnectDelayFloorMs: () => 45_000 });
    const delays = recordDelays(h.client);
    h.client.connect();
    h.reachReady();
    h.current().simulateClose(1011, 'node-unreachable');
    h.client.disconnect();
    expect(delays).toEqual([45_000]);
  });

  test('关闭码与原因留在客户端上供界面区分「入口到不了节点」；再次 READY 清空', () => {
    const h = flappingClient();
    h.client.connect();
    h.reachReady();
    h.current().simulateClose(1011, 'failover-exhausted');
    expect(h.client.getState()).toBe('RECONNECT_BACKOFF');
    expect(h.client.lastCloseCode).toBe(1011);
    expect(h.client.lastCloseReason).toBe('failover-exhausted');
    h.reconnectNow();
    h.reachReady();
    expect(h.client.lastCloseCode).toBeNull();
    expect(h.client.lastCloseReason).toBeNull();
    h.client.disconnect();
  });
});

type WakeKind = 'recovery' | 'hint';

function wake(client: BorshWebSocketClient, kind: WakeKind): void {
  (client as unknown as { handleResumeSignal(kind: WakeKind): void }).handleResumeSignal(kind);
}

function attemptsOf(client: BorshWebSocketClient): number {
  return (
    client as unknown as { reconnector: { getAttempts(): number } }
  ).reconnector.getAttempts();
}

describe('退避中的唤醒信号按来源区分（P2-2）', () => {
  test('线索类信号（connection change / 看门狗）不越过宿主下限、不清零退避计数', () => {
    const h = flappingClient({ reconnectDelayFloorMs: () => 60_000 });
    h.client.connect();
    for (let i = 0; i < 4; i += 1) {
      h.reachReady();
      h.current().simulateClose(1011, 'failover-exhausted');
      expect(h.client.getState()).toBe('RECONNECT_BACKOFF');
      wake(h.client, 'hint');
      expect(h.client.getState()).toBe('RECONNECT_BACKOFF');
      expect(h.sockets).toHaveLength(i + 1);
      h.reconnectNow();
    }
    expect(attemptsOf(h.client)).toBe(4);
    h.client.disconnect();
  });

  test('没有下限时线索类信号把排着的重连提前，但保留退避计数', () => {
    const h = flappingClient();
    h.client.connect();
    h.reachReady();
    h.current().simulateClose(1011, 'failover-exhausted');
    expect(attemptsOf(h.client)).toBe(1);
    wake(h.client, 'hint');
    expect(h.sockets).toHaveLength(2);
    expect(h.client.getState()).toBe('WS_CONNECTING');
    expect(attemptsOf(h.client)).toBe(1);
    h.client.disconnect();
  });

  test('恢复类信号（online / 回前台 / pageshow）照旧清零并立即重连', () => {
    const h = flappingClient({ reconnectDelayFloorMs: () => 60_000 });
    h.client.connect();
    h.reachReady();
    h.current().simulateClose(1011, 'failover-exhausted');
    wake(h.client, 'recovery');
    expect(h.sockets).toHaveLength(2);
    expect(attemptsOf(h.client)).toBe(0);
    h.client.disconnect();
  });
});

describe('primary 会话结束通知（F5 / F8）', () => {
  test('onSessionEnd 先于直连载体被关闭触发', () => {
    const h = flappingClient();
    h.client.connect();
    h.reachReady();
    const carrier = new FakeDirect();
    h.client.attachDirectCarrier(carrier);
    const order: string[] = [];
    h.client.onSessionEnd(() => order.push(`end:${carrier.closed}`));
    carrier.onClose(() => order.push('carrier-closed'));
    h.current().simulateClose();
    expect(order).toEqual(['end:false', 'carrier-closed']);

    h.reconnectNow();
    h.reachReady();
    h.client.reconnect();
    h.client.disconnect();
    expect(order.filter((row) => row.startsWith('end:'))).toHaveLength(3);
  });
});

describe('直连活跃时的存活判定（F3 低风险版）', () => {
  function directClient() {
    const socket = createFakeSocket();
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
      pongTimeoutMs: 30,
    });
    client.connect();
    socket.open();
    socket.deliver(helloFrame());
    socket.deliver(pongFrame(lastPingNonce(socket.sent)));
    const carrier = new FakeDirect();
    client.attachDirectCarrier(carrier);
    socket.deliver(switchFrame(1));
    expect(client.activeCarrier).toBe('direct');
    const ping = () => (client as unknown as { heartbeat: { ping(): void } }).heartbeat.ping();
    return { socket, client, carrier, ping };
  }

  test('PING 在直连上超时：摘掉直连回落 primary 并补探，primary 回了 PONG 就保持连接', async () => {
    const { socket, client, carrier, ping } = directClient();
    ping();
    expect(carrier.sent.length).toBe(1);
    const primaryBefore = socket.sent.length;
    await sleep(45);
    expect(client.activeCarrier).toBe('primary');
    expect(socket.sent.length).toBe(primaryBefore + 1);
    socket.deliver(pongFrame(lastPingNonce(socket.sent)));
    await sleep(45);
    expect(socket.closeCount).toBe(0);
    expect(client.getState()).toBe('READY');
    client.disconnect();
  });

  test('回前台的探测在直连上超时：不再补探，直接重连', async () => {
    const { socket, client } = directClient();
    const primaryBefore = socket.sent.length;
    wake(client, 'recovery');
    await sleep(45);
    expect(socket.sent.length).toBe(primaryBefore);
    expect(socket.closeCount).toBe(1);
    client.disconnect();
  });

  test('primary 上的补探也没回：这时才关 primary', async () => {
    const { socket, client, ping } = directClient();
    ping();
    await sleep(45);
    expect(socket.closeCount).toBe(0);
    await sleep(45);
    expect(socket.closeCount).toBe(1);
    client.disconnect();
  });
});
