// 回前台 / 网络恢复的僵尸链路探测（P7）：短期限 PING + 超时即强制重连。

import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { BorshWebSocketClient } from './client';
import {
  MAX_RESUME_PROBE_TIMEOUT_MS,
  MIN_RESUME_PROBE_TIMEOUT_MS,
  resolveResumeProbeTimeoutMs,
} from './heartbeat-cadence';
import { HeartbeatController } from './heartbeat-controller';
import { type FakeSocket, createFakeSocket, helloFrame } from './test-fakes';

function asUint8Array(data: ArrayBufferLike | ArrayBufferView | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function pingNonces(socket: FakeSocket): number[] {
  const nonces: number[] = [];
  for (const frame of socket.sent) {
    try {
      const envelope = wsBorsh.decodeEnvelope(asUint8Array(frame));
      if (envelope.kind !== wsBorsh.KIND_PING) continue;
      nonces.push(wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, envelope.payload).nonce);
    } catch {}
  }
  return nonces;
}

function pongFrame(nonce: number): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
    nonce,
    timeMs: BigInt(Date.now()),
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, payload, 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** document + window 替身：驱动 visibilitychange / pageshow / online 三条恢复信号。 */
function stubBrowser(): {
  setVisibility: (value: string) => void;
  visibilitychange: () => void;
  pageshow: (persisted: boolean) => void;
  online: () => void;
  restore: () => void;
} {
  const docListeners = new Set<() => void>();
  const winListeners = new Map<string, Set<(event?: unknown) => void>>();
  const bucket = (type: string) => {
    const existing = winListeners.get(type);
    if (existing) return existing;
    const created = new Set<(event?: unknown) => void>();
    winListeners.set(type, created);
    return created;
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') docListeners.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      if (type === 'visibilitychange') docListeners.delete(handler);
    },
  };
  const win = {
    addEventListener(type: string, handler: (event?: unknown) => void) {
      bucket(type).add(handler);
    },
    removeEventListener(type: string, handler: (event?: unknown) => void) {
      bucket(type).delete(handler);
    },
  };
  const saved = new Map<string, { had: boolean; value: unknown }>();
  const define = (key: string, value: unknown) => {
    saved.set(key, { had: key in globalThis, value: Reflect.get(globalThis, key) });
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('document', doc);
  define('window', win);
  define('navigator', {});

  return {
    setVisibility: (value) => {
      doc.visibilityState = value;
    },
    visibilitychange: () => {
      for (const handler of [...docListeners]) handler();
    },
    pageshow: (persisted) => {
      for (const handler of [...bucket('pageshow')]) handler({ persisted });
    },
    online: () => {
      for (const handler of [...bucket('online')]) handler();
    },
    restore: () => {
      for (const [key, entry] of saved) {
        if (entry.had) {
          Object.defineProperty(globalThis, key, {
            value: entry.value,
            configurable: true,
            writable: true,
          });
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    },
  };
}

/** 已经 READY 的客户端；`pongTimeoutMs` 同时就是恢复探测期限的上限（取 min）。 */
function readyClient(pongTimeoutMs: number): {
  client: BorshWebSocketClient;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 60_000,
    pongTimeoutMs,
    reconnectDelayMs: 60_000,
  });
  client.connect();
  sockets[0]?.open();
  sockets[0]?.deliver(helloFrame());
  return { client, sockets };
}

describe('resolveResumeProbeTimeoutMs', () => {
  test('没有 RTT 样本时取上限', () => {
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: null, pongTimeoutMs: 30_000 })).toBe(
      MAX_RESUME_PROBE_TIMEOUT_MS
    );
  });

  test('4× 中位数落在区间内时原样取用', () => {
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: 800, pongTimeoutMs: 30_000 })).toBe(3200);
  });

  test('低 RTT 被下限兜住', () => {
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: 20, pongTimeoutMs: 30_000 })).toBe(
      MIN_RESUME_PROBE_TIMEOUT_MS
    );
  });

  test('高 RTT 被上限压住', () => {
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: 5000, pongTimeoutMs: 30_000 })).toBe(
      MAX_RESUME_PROBE_TIMEOUT_MS
    );
  });

  test('永远不超过常规 PONG 期限', () => {
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: null, pongTimeoutMs: 1500 })).toBe(1500);
  });

  test('非有限 / 非正的中位数按「无样本」处理', () => {
    expect(
      resolveResumeProbeTimeoutMs({ medianLatencyMs: Number.NaN, pongTimeoutMs: 30_000 })
    ).toBe(MAX_RESUME_PROBE_TIMEOUT_MS);
    expect(resolveResumeProbeTimeoutMs({ medianLatencyMs: 0, pongTimeoutMs: 30_000 })).toBe(
      MAX_RESUME_PROBE_TIMEOUT_MS
    );
  });
});

describe('HeartbeatController.pingWithDeadline', () => {
  test('只给本次探测换期限，超时走本次的处置函数', async () => {
    let regular = 0;
    let probe = 0;
    const controller = new HeartbeatController({
      intervalMs: 60_000,
      pongTimeoutMs: 60_000,
      sendPing: () => true,
      onPongTimeout: () => {
        regular += 1;
      },
    });

    controller.pingWithDeadline(30, () => {
      probe += 1;
    });
    await sleep(80);

    expect(probe).toBe(1);
    expect(regular).toBe(0);
    expect(controller.hasPendingPong()).toBe(false);
    controller.stop();
  });

  test('在途探测被作废重发：常规期限的那条 PING 不再挡路', () => {
    const nonces: number[] = [];
    const controller = new HeartbeatController({
      intervalMs: 60_000,
      pongTimeoutMs: 60_000,
      sendPing: (nonce) => {
        nonces.push(nonce);
        return true;
      },
      onPongTimeout: () => {},
    });

    expect(controller.ping()).not.toBeNull();
    // 常规 ping 在途时 ping() 会被跳过
    expect(controller.ping()).toBeNull();
    // 恢复探测不受在途约束
    expect(controller.pingWithDeadline(5_000)).not.toBeNull();
    expect(nonces.length).toBe(2);
    controller.stop();
  });

  test('收到 PONG 后下一拍回到常规期限', async () => {
    let regular = 0;
    let probe = 0;
    let last = 0;
    const controller = new HeartbeatController({
      intervalMs: 60_000,
      pongTimeoutMs: 40,
      sendPing: (nonce) => {
        last = nonce;
        return true;
      },
      onPongTimeout: () => {
        regular += 1;
      },
    });

    const probeNonce = controller.pingWithDeadline(10_000, () => {
      probe += 1;
    });
    expect(probeNonce).not.toBeNull();
    controller.notePong(probeNonce as number);
    controller.ping();
    await sleep(90);

    expect(probe).toBe(0);
    expect(regular).toBe(1);
    expect(last).not.toBe(probeNonce);
    controller.stop();
  });

  test('medianLatencyMs 从 PONG 样本推出来', () => {
    let nonce = 0;
    let clock = 1000;
    const controller = new HeartbeatController({
      intervalMs: 60_000,
      pongTimeoutMs: 60_000,
      sendPing: (value) => {
        nonce = value;
        return true;
      },
      onPongTimeout: () => {},
      now: () => clock,
    });

    expect(controller.medianLatencyMs).toBeNull();
    controller.ping();
    clock = 1100;
    controller.notePong(nonce);
    clock = 2000;
    controller.ping();
    clock = 2300;
    controller.notePong(nonce);

    expect(controller.medianLatencyMs).toBe(200);
    controller.stop();
  });
});

describe('回前台的僵尸链路探测', () => {
  test('链路还活着：探测收到 PONG，不重连也不关 socket', async () => {
    const browser = stubBrowser();
    try {
      const { client, sockets } = readyClient(80);
      const socket = sockets[0] as FakeSocket;
      const before = pingNonces(socket).length;

      browser.setVisibility('hidden');
      browser.visibilitychange();
      browser.setVisibility('visible');
      browser.visibilitychange();

      const nonces = pingNonces(socket);
      expect(nonces.length).toBe(before + 1);
      socket.deliver(pongFrame(nonces[nonces.length - 1] as number));

      await sleep(180);
      expect(sockets.length).toBe(1);
      expect(socket.closeCount).toBe(0);
      expect(client.getState()).toBe('READY');
      client.disconnect();
    } finally {
      browser.restore();
    }
  });

  test('链路是僵尸：短期限一到就强制重连，不等常规 PONG 超时', async () => {
    const browser = stubBrowser();
    try {
      const { client, sockets } = readyClient(80);
      const socket = sockets[0] as FakeSocket;

      browser.setVisibility('hidden');
      browser.visibilitychange();
      browser.setVisibility('visible');
      browser.visibilitychange();
      expect(sockets.length).toBe(1);

      await sleep(200);
      expect(socket.closeCount).toBe(1);
      expect(sockets.length).toBe(2);
      expect(client.getState()).toBe('WS_CONNECTING');
      client.disconnect();
    } finally {
      browser.restore();
    }
  });

  test('pageshow 不论 persisted 都做短期限探测（iOS 切网常不带 persisted）', async () => {
    const browser = stubBrowser();
    try {
      const { client, sockets } = readyClient(80);
      const socket = sockets[0] as FakeSocket;
      const before = pingNonces(socket).length;

      browser.pageshow(false);
      expect(pingNonces(socket).length).toBe(before + 1);

      await sleep(200);
      expect(sockets.length).toBe(2);
      client.disconnect();
    } finally {
      browser.restore();
    }
  });

  test('READY 时的 online 走探测而不是重连', () => {
    const browser = stubBrowser();
    try {
      const { client, sockets } = readyClient(30_000);
      const socket = sockets[0] as FakeSocket;
      const before = pingNonces(socket).length;

      browser.online();

      expect(sockets.length).toBe(1);
      expect(pingNonces(socket).length).toBe(before + 1);
      client.disconnect();
    } finally {
      browser.restore();
    }
  });

  test('连着到的恢复信号只探测一次', () => {
    const browser = stubBrowser();
    try {
      const { client, sockets } = readyClient(30_000);
      const socket = sockets[0] as FakeSocket;
      const before = pingNonces(socket).length;

      browser.visibilitychange();
      browser.pageshow(true);
      browser.online();

      expect(pingNonces(socket).length).toBe(before + 1);
      client.disconnect();
    } finally {
      browser.restore();
    }
  });

  test('未 READY 时恢复信号仍然是立刻重连', () => {
    const browser = stubBrowser();
    try {
      const sockets: FakeSocket[] = [];
      const client = new BorshWebSocketClient({
        url: 'ws://example.test/ws',
        socketFactory: () => {
          const socket = createFakeSocket();
          sockets.push(socket);
          return socket;
        },
        reconnectDelayMs: 60_000,
      });
      client.connect();
      sockets[0]?.simulateClose();
      expect(client.getState()).toBe('RECONNECT_BACKOFF');

      browser.pageshow(true);
      expect(sockets.length).toBe(2);
      client.disconnect();
    } finally {
      browser.restore();
    }
  });
});
