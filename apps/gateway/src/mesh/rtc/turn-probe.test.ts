import { afterEach, describe, expect, test } from 'bun:test';
import {
  STUN_MAGIC_COOKIE,
  type StunProbeResult,
  type StunRinfo,
  type StunUdpSocket,
  encodeBindingRequest,
} from './stun-probe';
import { resetStunResolverForTest } from './stun-resolver';
import {
  TURN_PROBE_INTERVAL_MS,
  TURN_PROBE_MIN_INTERVAL_MS,
  configuredTurnUrls,
  parseTurnProbeTarget,
  probeTurnServer,
  resetTurnProbeForTest,
  setTurnProbeLoopForTest,
  startMeshTurnProbe,
  stopMeshTurnProbe,
  syncTurnProbe,
  turnProbeSnapshot,
  turnUrlOf,
} from './turn-probe';

afterEach(() => {
  resetTurnProbeForTest();
  resetStunResolverForTest();
});

const TXID = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);

function viewOf(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function encodeSuccess(txid: Uint8Array, attrs: Uint8Array): Uint8Array {
  const buf = new Uint8Array(20 + attrs.length);
  const view = viewOf(buf);
  view.setUint16(0, 0x0101);
  view.setUint16(2, attrs.length);
  view.setUint32(4, STUN_MAGIC_COOKIE);
  buf.set(txid.subarray(0, 12), 8);
  buf.set(attrs, 20);
  return buf;
}

function xorMappedIpv4(ip: string, port: number): Uint8Array {
  const attr = new Uint8Array(12);
  const view = viewOf(attr);
  view.setUint16(0, 0x0020);
  view.setUint16(2, 8);
  attr[5] = 0x01;
  view.setUint16(6, port ^ 0x2112);
  const magic = [0x21, 0x12, 0xa4, 0x42];
  const parts = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) attr[8 + i] = (parts[i] ?? 0) ^ (magic[i] ?? 0);
  return attr;
}

class FakeSocket implements StunUdpSocket {
  sent: Array<{ msg: Uint8Array; port: number; address: string }> = [];
  closed = false;
  sendError: Error | null = null;
  private readonly messages: Array<(msg: Uint8Array, rinfo: StunRinfo) => void> = [];
  private readonly errors: Array<(err: Error) => void> = [];
  private readonly sendWaiters: Array<() => void> = [];

  send(
    msg: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void {
    this.sent.push({ msg, port, address });
    callback?.(this.sendError);
    for (const waiter of this.sendWaiters.splice(0)) waiter();
  }

  waitForSend(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length >= 1) resolve();
        else this.sendWaiters.push(check);
      };
      check();
    });
  }

  on(event: 'message', listener: (msg: Uint8Array, rinfo: StunRinfo) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(
    event: 'message' | 'error',
    listener: ((msg: Uint8Array, rinfo: StunRinfo) => void) | ((err: Error) => void)
  ): void {
    if (event === 'message')
      this.messages.push(listener as (msg: Uint8Array, rinfo: StunRinfo) => void);
    else this.errors.push(listener as (err: Error) => void);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(msg: Uint8Array, rinfo?: StunRinfo): void {
    const info =
      rinfo ??
      (this.sent[0]
        ? { address: this.sent[0].address, port: this.sent[0].port }
        : { address: '0.0.0.0', port: 0 });
    for (const listener of this.messages) listener(msg, info);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function loopOpts(probeAll: (urls: readonly string[]) => Promise<StunProbeResult[]>): void {
  setTurnProbeLoopForTest({
    now: () => 50_000,
    random: () => 0.5,
    minIntervalMs: 0,
    probeAll,
  });
}

describe('turnUrlOf / parseTurnProbeTarget', () => {
  test('extracts url from the hub/local TURN object', () => {
    expect(turnUrlOf({ url: 'turn:relay.example:3478', username: 'u', credential: 'p' })).toBe(
      'turn:relay.example:3478'
    );
    expect(turnUrlOf({ hostname: '203.0.113.9', port: 40250, relayType: 'TurnUdp' })).toBe(
      'turn:203.0.113.9:40250'
    );
    expect(turnUrlOf(null)).toBeNull();
  });

  test('parses UDP turn: and rejects turns / tcp', () => {
    expect(parseTurnProbeTarget('turn:relay.example:3478')).toEqual({
      hostname: 'relay.example',
      port: 3478,
    });
    expect(parseTurnProbeTarget('turn:4.2.2.2:40250?transport=udp')).toEqual({
      hostname: '4.2.2.2',
      port: 40250,
    });
    expect(parseTurnProbeTarget('turn:[2001:db8::1]:3478')).toEqual({
      hostname: '2001:db8::1',
      port: 3478,
    });
    expect(parseTurnProbeTarget('turns:relay.example:5349')).toBeNull();
    expect(parseTurnProbeTarget('turn:relay.example:3478?transport=tcp')).toBeNull();
    expect(parseTurnProbeTarget('stun:stun.example:3478')).toBeNull();
    expect(parseTurnProbeTarget('not-a-url')).toBeNull();
  });
});

describe('probeTurnServer', () => {
  test('skips turns/tcp/stun as unsupported-scheme', async () => {
    for (const url of [
      'turns:relay.example:5349',
      'turn:relay.example:3478?transport=tcp',
      'stun:stun.example:3478',
    ]) {
      const result = await probeTurnServer(url, {
        createSocket: () => {
          throw new Error('socket should not open');
        },
      });
      expect(result).toEqual({ url, ok: false, rttMs: 0, skipped: 'unsupported-scheme' });
    }
  });

  test('returns url error without opening a socket', async () => {
    const result = await probeTurnServer('not-a-url', {
      createSocket: () => {
        throw new Error('socket should not open');
      },
    });
    expect(result).toMatchObject({ url: 'not-a-url', ok: false, error: 'url' });
  });

  test('sends a Binding request to the TURN host:port and records rtt', async () => {
    const sock = new FakeSocket();
    const clock = { now: 1_000 };
    const pending = probeTurnServer('turn:relay.example:40250?transport=udp', {
      lookup: async () => ['203.0.113.50'],
      createSocket: () => sock,
      now: () => clock.now,
      randomTxid: () => TXID,
      timeoutMs: 200,
    });
    await sock.waitForSend();
    expect(sock.sent[0]?.port).toBe(40250);
    expect(sock.sent[0]?.address).toBe('203.0.113.50');
    expect([...sock.sent[0]!.msg]).toEqual([...encodeBindingRequest(TXID)]);
    clock.now = 1_042;
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('198.51.100.7', 40000)));
    const result = await pending;
    expect(result).toMatchObject({
      url: 'turn:relay.example:40250?transport=udp',
      ok: true,
      rttMs: 42,
      mappedAddress: '198.51.100.7:40000',
      resolvedIp: '203.0.113.50',
    });
    expect(sock.closed).toBe(true);
  });
});

describe('mesh TURN probe loop', () => {
  test('probes turnConfigured even when effective turn is gated off', async () => {
    const calls: string[][] = [];
    loopOpts(async (urls) => {
      calls.push([...urls]);
      return urls.map((url) => ({ url, ok: false, rttMs: 2000, error: 'timeout' }));
    });
    const ice = {
      turn: null as unknown,
      turnConfigured: {
        url: 'turn:relay.example:3478',
        username: 'u',
        credential: 'p',
      } as unknown,
    };
    const rtc = { currentIceConfig: () => ice };
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    startMeshTurnProbe(rtc, {
      interval(fn, ms) {
        const rec = { fn, ms, cleared: false };
        timers.push(rec);
        return {
          clear() {
            rec.cleared = true;
          },
        };
      },
    });
    await flush();
    expect(calls).toEqual([['turn:relay.example:3478']]);
    expect(timers[0]?.ms).toBe(TURN_PROBE_INTERVAL_MS);
    expect(turnProbeSnapshot()[0]).toMatchObject({
      url: 'turn:relay.example:3478',
      ok: false,
      error: 'timeout',
      probedAt: 50_000,
    });
    expect(configuredTurnUrls(rtc)).toEqual(['turn:relay.example:3478']);

    ice.turnConfigured = { url: 'turn:other.example:3478', username: 'u', credential: 'p' };
    syncTurnProbe(rtc);
    await flush();
    expect(calls).toEqual([['turn:relay.example:3478'], ['turn:other.example:3478']]);

    stopMeshTurnProbe();
    expect(timers[0]?.cleared).toBe(true);
  });

  test('10-minute tick is jittered by ±10%', () => {
    setTurnProbeLoopForTest({ random: () => 0, probeAll: async () => [] });
    const timers: number[] = [];
    startMeshTurnProbe(
      { currentIceConfig: () => ({ turn: null }) },
      {
        interval(_fn, ms) {
          timers.push(ms);
          return { clear() {} };
        },
      }
    );
    expect(timers[0]).toBe(Math.round(TURN_PROBE_INTERVAL_MS * 0.9));
    resetTurnProbeForTest();
    setTurnProbeLoopForTest({ random: () => 1, probeAll: async () => [] });
    startMeshTurnProbe(
      { currentIceConfig: () => ({ turn: null }) },
      {
        interval(_fn, ms) {
          timers.push(ms);
          return { clear() {} };
        },
      }
    );
    expect(timers[1]).toBe(Math.round(TURN_PROBE_INTERVAL_MS * 1.1));
  });

  test('change-triggered cycles wait at least 30s', async () => {
    const clock = { now: 1_000 };
    const calls: string[][] = [];
    setTurnProbeLoopForTest({
      now: () => clock.now,
      random: () => 0.5,
      minIntervalMs: TURN_PROBE_MIN_INTERVAL_MS,
      probeAll: async (urls) => {
        calls.push([...urls]);
        return urls.map((url) => ({ url, ok: true, rttMs: 1 }));
      },
    });
    const ice = { turn: 'turn:a:3478' as unknown };
    const rtc = { currentIceConfig: () => ice };
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    startMeshTurnProbe(rtc, {
      interval(fn, ms) {
        const rec = { fn, ms, cleared: false };
        timers.push(rec);
        return {
          clear() {
            rec.cleared = true;
          },
        };
      },
    });
    await flush();
    expect(calls).toHaveLength(1);
    clock.now = 11_000;
    ice.turn = 'turn:b:3478';
    syncTurnProbe(rtc);
    await flush();
    expect(calls).toHaveLength(1);
    const wait = timers.find((row) => row.ms === 20_000);
    expect(wait).toBeTruthy();
    clock.now = 31_000;
    wait!.fn();
    await flush();
    expect(calls).toEqual([['turn:a:3478'], ['turn:b:3478']]);
  });

  test('logs info per probe and warns when unreachable', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    console.warn = (line?: unknown) => {
      warns.push(String(line));
    };
    try {
      loopOpts(async (urls) =>
        urls.map((url) => ({ url, ok: false, rttMs: 2000, error: 'timeout' }))
      );
      startMeshTurnProbe(
        { currentIceConfig: () => ({ turn: 'turn:relay.example:3478' }) },
        { interval: () => ({ clear() {} }) }
      );
      await flush();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    expect(
      logs.some(
        (line) => line.includes('turn probe') && line.includes('url=turn:relay.example:3478')
      )
    ).toBe(true);
    expect(logs.some((line) => line.includes('ok=false') && line.includes('error=timeout'))).toBe(
      true
    );
    expect(
      warns.some(
        (line) => line.includes('turn unreachable') && line.includes('url=turn:relay.example:3478')
      )
    ).toBe(true);
  });

  test('test env without probeAll skips the network', async () => {
    startMeshTurnProbe(
      { currentIceConfig: () => ({ turn: 'turn:relay.example:3478' }) },
      {
        interval(fn) {
          fn();
          return { clear() {} };
        },
      }
    );
    await flush();
    expect(turnProbeSnapshot()).toEqual([]);
  });
});
