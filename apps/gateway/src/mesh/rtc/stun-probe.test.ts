import { afterEach, describe, expect, test } from 'bun:test';
import {
  STUN_MAGIC_COOKIE,
  STUN_PROBE_INTERVAL_MS,
  type StunProbeResult,
  type StunUdpSocket,
  encodeBindingRequest,
  parseStunMappedAddress,
  parseStunTarget,
  probeStunServer,
  probeStunServers,
  resetStunProbeForTest,
  setStunProbeLoopForTest,
  startMeshStunProbe,
  stopMeshStunProbe,
  stunProbeSnapshot,
  syncStunProbe,
  withStunProbes,
} from './stun-probe';

afterEach(() => {
  resetStunProbeForTest();
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

function mappedIpv4(ip: string, port: number): Uint8Array {
  const attr = new Uint8Array(12);
  const view = viewOf(attr);
  view.setUint16(0, 0x0001);
  view.setUint16(2, 8);
  attr[5] = 0x01;
  view.setUint16(6, port);
  const parts = ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) attr[8 + i] = parts[i] ?? 0;
  return attr;
}

function xorMappedIpv6(ip: string, port: number, txid: Uint8Array): Uint8Array {
  const attr = new Uint8Array(24);
  const view = viewOf(attr);
  view.setUint16(0, 0x0020);
  view.setUint16(2, 20);
  attr[5] = 0x02;
  view.setUint16(6, port ^ 0x2112);
  const mask = Uint8Array.of(0x21, 0x12, 0xa4, 0x42, ...txid.subarray(0, 12));
  const groups = ip.split(':').map((g) => Number.parseInt(g || '0', 16));
  for (let i = 0; i < 8; i++) {
    const raw = groups[i] ?? 0;
    const xored = raw ^ (((mask[i * 2] ?? 0) << 8) | (mask[i * 2 + 1] ?? 0));
    attr[8 + i * 2] = (xored >>> 8) & 0xff;
    attr[9 + i * 2] = xored & 0xff;
  }
  return attr;
}

class FakeSocket implements StunUdpSocket {
  sent: Array<{ msg: Uint8Array; port: number; address: string }> = [];
  closed = false;
  sendError: Error | null = null;
  private readonly messages: Array<(msg: Uint8Array) => void> = [];
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
    if (this.sent.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  on(event: 'message', listener: (msg: Uint8Array) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(
    event: 'message' | 'error',
    listener: ((msg: Uint8Array) => void) | ((err: Error) => void)
  ): void {
    if (event === 'message') this.messages.push(listener as (msg: Uint8Array) => void);
    else this.errors.push(listener as (err: Error) => void);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(msg: Uint8Array): void {
    for (const listener of this.messages) listener(msg);
  }

  emitError(err: Error): void {
    for (const listener of this.errors) listener(err);
  }
}

describe('parseStunTarget', () => {
  test('parses stun:host:port the same way ice.ts parseTurnUri does', () => {
    expect(parseStunTarget('stun:stun.miwifi.com:3478')).toEqual({
      hostname: 'stun.miwifi.com',
      port: 3478,
    });
    expect(parseStunTarget('stun:stun.l.google.com:19302')).toEqual({
      hostname: 'stun.l.google.com',
      port: 19302,
    });
    expect(parseStunTarget('stun:[2001:db8::1]:3478')).toEqual({
      hostname: '2001:db8::1',
      port: 3478,
    });
    expect(parseStunTarget('stun:only-host')).toEqual({ hostname: 'only-host', port: 3478 });
    expect(parseStunTarget('stuns:tls.example:5349')).toBeNull();
    expect(parseStunTarget('turn:relay.example:3478')).toBeNull();
    expect(parseStunTarget('not-a-url')).toBeNull();
  });
});

describe('STUN Binding codec', () => {
  test('encodes a 20-byte Binding request with magic cookie and txid', () => {
    const req = encodeBindingRequest(TXID);
    expect(req.byteLength).toBe(20);
    const view = viewOf(req);
    expect(view.getUint16(0)).toBe(0x0001);
    expect(view.getUint16(2)).toBe(0);
    expect(view.getUint32(4)).toBe(STUN_MAGIC_COOKIE);
    expect([...req.subarray(8)]).toEqual([...TXID]);
  });

  test('parses XOR-MAPPED-ADDRESS IPv4 and prefers it over MAPPED-ADDRESS', () => {
    const xor = xorMappedIpv4('203.0.113.10', 54321);
    const mapped = mappedIpv4('198.51.100.8', 9);
    const attrs = new Uint8Array(mapped.length + xor.length);
    attrs.set(mapped, 0);
    attrs.set(xor, mapped.length);
    expect(parseStunMappedAddress(encodeSuccess(TXID, attrs), TXID)).toBe('203.0.113.10:54321');
  });

  test('falls back to MAPPED-ADDRESS IPv4', () => {
    expect(parseStunMappedAddress(encodeSuccess(TXID, mappedIpv4('192.0.2.1', 3478)), TXID)).toBe(
      '192.0.2.1:3478'
    );
  });

  test('parses XOR-MAPPED-ADDRESS IPv6', () => {
    const ip = '2001:db8:0:0:0:0:0:1';
    const msg = encodeSuccess(TXID, xorMappedIpv6(ip, 3478, TXID));
    expect(parseStunMappedAddress(msg, TXID)).toBe('[2001:db8:0:0:0:0:0:1]:3478');
  });

  test('rejects mismatched transaction id', () => {
    const other = Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9);
    expect(
      parseStunMappedAddress(encodeSuccess(other, xorMappedIpv4('203.0.113.10', 1)), TXID)
    ).toBeNull();
  });
});

describe('probeStunServer', () => {
  test('returns url error for a non-stun URL without opening a socket', async () => {
    const result = await probeStunServer('turn:example:3478', {
      createSocket: () => {
        throw new Error('socket should not open');
      },
    });
    expect(result).toMatchObject({ url: 'turn:example:3478', ok: false, error: 'url' });
  });

  test('returns dns when lookup fails', async () => {
    const result = await probeStunServer('stun:missing.example:3478', {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result).toMatchObject({ url: 'stun:missing.example:3478', ok: false, error: 'dns' });
    expect(result.resolvedIp).toBeUndefined();
  });

  test('exchanges a Binding request and records rtt plus mapped address', async () => {
    const sock = new FakeSocket();
    const clock = { now: 1_000 };
    const pending = probeStunServer('stun:stun.example:3478', {
      lookup: async () => ({ address: '203.0.113.50', family: 4 }),
      createSocket: () => sock,
      now: () => clock.now,
      randomTxid: () => TXID,
      timeoutMs: 200,
    });
    await sock.waitForSend();
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0]?.port).toBe(3478);
    expect(sock.sent[0]?.address).toBe('203.0.113.50');
    expect([...sock.sent[0]!.msg]).toEqual([...encodeBindingRequest(TXID)]);
    clock.now = 1_042;
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('198.51.100.7', 40000)));
    const result = await pending;
    expect(result).toEqual({
      url: 'stun:stun.example:3478',
      ok: true,
      rttMs: 42,
      mappedAddress: '198.51.100.7:40000',
      resolvedIp: '203.0.113.50',
    });
    expect(sock.closed).toBe(true);
  });

  test('skips IP lookup for literals and times out without a reply', async () => {
    const sock = new FakeSocket();
    const result = await probeStunServer('stun:192.0.2.9:3478', {
      lookup: async () => {
        throw new Error('lookup should not run');
      },
      createSocket: () => sock,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(result.resolvedIp).toBe('192.0.2.9');
    expect(sock.closed).toBe(true);
  });

  test('ignores a reply with the wrong txid until timeout', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      randomTxid: () => TXID,
      timeoutMs: 20,
    });
    sock.emitMessage(
      encodeSuccess(
        Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        xorMappedIpv4('198.51.100.1', 1)
      )
    );
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });

  test('probes several servers concurrently', async () => {
    const resultByHost: Record<string, StunProbeResult> = {
      'stun:a.example:3478': {
        url: 'stun:a.example:3478',
        ok: true,
        rttMs: 5,
        mappedAddress: '1.1.1.1:1',
        resolvedIp: '9.9.9.9',
      },
      'stun:b.example:3478': { url: 'stun:b.example:3478', ok: false, rttMs: 20, error: 'timeout' },
    };
    const sockets: FakeSocket[] = [];
    const results = await probeStunServers(
      ['stun:a.example:3478', 'stun:b.example:3478', 'not-stun'],
      {
        lookup: async (hostname) => ({
          address: hostname === 'a.example' ? '9.9.9.9' : '8.8.8.8',
          family: 4,
        }),
        createSocket: () => {
          const sock = new FakeSocket();
          sockets.push(sock);
          queueMicrotask(() => {
            const sent = sock.sent[0];
            if (!sent) return;
            const url = sent.address === '9.9.9.9' ? 'stun:a.example:3478' : 'stun:b.example:3478';
            if (url === 'stun:a.example:3478') {
              sock.emitMessage(
                encodeSuccess(sent.msg.subarray(8, 20), xorMappedIpv4('1.1.1.1', 1))
              );
            }
          });
          return sock;
        },
        timeoutMs: 40,
      }
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ ok: true, mappedAddress: '1.1.1.1:1' });
    expect(results[1]).toMatchObject({ ok: false, error: 'timeout' });
    expect(results[2]).toMatchObject({ ok: false, error: 'url' });
    expect(resultByHost['stun:a.example:3478']?.ok).toBe(true);
  });
});

describe('mesh STUN probe loop', () => {
  test('one-shot plus interval plus list-change re-probe, and withStunProbes snapshot', async () => {
    const calls: string[][] = [];
    setStunProbeLoopForTest({
      now: () => 50_000,
      probeAll: async (urls) => {
        calls.push([...urls]);
        return urls.map((url) => ({
          url,
          ok: url.includes('ok'),
          rttMs: 7,
          mappedAddress: url.includes('ok') ? '203.0.113.9:9' : undefined,
          error: url.includes('ok') ? undefined : 'timeout',
        }));
      },
    });
    const ice = { stun: ['stun:ok.example:3478'] };
    const rtc = { currentIceConfig: () => ice };
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    startMeshStunProbe(rtc, {
      interval(fn, ms) {
        timers.push({ fn, ms, cleared: false });
        return {
          clear() {
            timers[timers.length - 1]!.cleared = true;
          },
        };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([['stun:ok.example:3478']]);
    expect(timers[0]?.ms).toBe(STUN_PROBE_INTERVAL_MS);
    expect(stunProbeSnapshot()[0]).toMatchObject({
      url: 'stun:ok.example:3478',
      ok: true,
      probedAt: 50_000,
      mappedAddress: '203.0.113.9:9',
    });
    expect(withStunProbes({ stun: ['stun:ok.example:3478'], turn: null })).toEqual({
      stun: ['stun:ok.example:3478'],
      turn: null,
      probes: [...stunProbeSnapshot()],
    });

    ice.stun = ['stun:ok.example:3478'];
    syncStunProbe(rtc);
    expect(calls).toHaveLength(1);

    ice.stun = ['stun:down.example:3478'];
    syncStunProbe(rtc);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([['stun:ok.example:3478'], ['stun:down.example:3478']]);
    expect(stunProbeSnapshot()[0]?.ok).toBe(false);

    timers[0]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(3);

    stopMeshStunProbe();
    expect(timers[0]?.cleared).toBe(true);
  });

  test('logs one info line per server and warns when none answer', async () => {
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
      setStunProbeLoopForTest({
        now: () => 1,
        probeAll: async (urls) =>
          urls.map((url) => ({ url, ok: false, rttMs: 2000, error: 'timeout' })),
      });
      startMeshStunProbe(
        { currentIceConfig: () => ({ stun: ['stun:a:1', 'stun:b:1'] }) },
        { interval: () => ({ clear() {} }) }
      );
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    expect(logs.some((line) => line.includes('stun probe') && line.includes('url=stun:a:1'))).toBe(
      true
    );
    expect(logs.some((line) => line.includes('ok=false') && line.includes('error=timeout'))).toBe(
      true
    );
    expect(warns.some((line) => line.includes('stun unreachable') && line.includes('all=2'))).toBe(
      true
    );
  });
});
