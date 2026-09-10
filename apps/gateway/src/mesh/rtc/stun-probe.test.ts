import { afterEach, describe, expect, test } from 'bun:test';
import {
  STUN_MAGIC_COOKIE,
  STUN_PROBE_INTERVAL_MS,
  STUN_PROBE_MIN_INTERVAL_MS,
  type StunProbeResult,
  type StunRinfo,
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
import { resetStunResolverForTest } from './stun-resolver';

afterEach(() => {
  resetStunProbeForTest();
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

function encodeBindingError(txid: Uint8Array): Uint8Array {
  const buf = new Uint8Array(20);
  const view = viewOf(buf);
  view.setUint16(0, 0x0111);
  view.setUint16(2, 0);
  view.setUint32(4, STUN_MAGIC_COOKIE);
  buf.set(txid.subarray(0, 12), 8);
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

function ipv6Groups(ip: string): number[] {
  return ip.split(':').map((g) => Number.parseInt(g || '0', 16));
}

function xorMappedIpv6(ip: string, port: number, txid: Uint8Array): Uint8Array {
  const attr = new Uint8Array(24);
  const view = viewOf(attr);
  view.setUint16(0, 0x0020);
  view.setUint16(2, 20);
  attr[5] = 0x02;
  view.setUint16(6, port ^ 0x2112);
  const mask = Uint8Array.of(0x21, 0x12, 0xa4, 0x42, ...txid.subarray(0, 12));
  const groups = ipv6Groups(ip);
  for (let i = 0; i < 8; i++) {
    const raw = groups[i] ?? 0;
    const xored = raw ^ (((mask[i * 2] ?? 0) << 8) | (mask[i * 2 + 1] ?? 0));
    attr[8 + i * 2] = (xored >>> 8) & 0xff;
    attr[9 + i * 2] = xored & 0xff;
  }
  return attr;
}

function mappedIpv6(ip: string, port: number): Uint8Array {
  const attr = new Uint8Array(24);
  const view = viewOf(attr);
  view.setUint16(0, 0x0001);
  view.setUint16(2, 20);
  attr[5] = 0x02;
  view.setUint16(6, port);
  const groups = ipv6Groups(ip);
  for (let i = 0; i < 8; i++) {
    const raw = groups[i] ?? 0;
    attr[8 + i * 2] = (raw >>> 8) & 0xff;
    attr[9 + i * 2] = raw & 0xff;
  }
  return attr;
}

function softwareAttr(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const padded = (bytes.length + 3) & ~3;
  const attr = new Uint8Array(4 + padded);
  const view = viewOf(attr);
  view.setUint16(0, 0x8022);
  view.setUint16(2, bytes.length);
  attr.set(bytes, 4);
  return attr;
}

function concatAttrs(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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
    return this.waitForSendCount(1);
  }

  waitForSendCount(n: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length >= n) resolve();
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

  emitError(err: Error): void {
    for (const listener of this.errors) listener(err);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function loopOpts(probeAll: StunProbeLoopProbe): void {
  setStunProbeLoopForTest({
    now: () => 50_000,
    random: () => 0.5,
    minIntervalMs: 0,
    probeAll,
  });
}

type StunProbeLoopProbe = (urls: readonly string[]) => Promise<StunProbeResult[]>;

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
    expect(parseStunTarget('turns:relay.example:5349')).toBeNull();
    expect(parseStunTarget('not-a-url')).toBeNull();
  });

  test('does not treat stuns: as stun: even though it shares the prefix', () => {
    expect(parseStunTarget('stuns:tls.example:5349')).toBeNull();
    expect(parseStunTarget('stun:tls.example:5349')).toEqual({
      hostname: 'tls.example',
      port: 5349,
    });
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
    expect(parseStunMappedAddress(encodeSuccess(TXID, concatAttrs(mapped, xor)), TXID)).toBe(
      '203.0.113.10:54321'
    );
  });

  test('falls back to MAPPED-ADDRESS IPv4', () => {
    expect(parseStunMappedAddress(encodeSuccess(TXID, mappedIpv4('192.0.2.1', 3478)), TXID)).toBe(
      '192.0.2.1:3478'
    );
  });

  test('parses XOR-MAPPED-ADDRESS IPv6 with RFC 5952 compression', () => {
    const ip = '2001:db8:0:0:0:0:0:1';
    const msg = encodeSuccess(TXID, xorMappedIpv6(ip, 3478, TXID));
    expect(parseStunMappedAddress(msg, TXID)).toBe('[2001:db8::1]:3478');
  });

  test('parses MAPPED-ADDRESS IPv6 and compresses the leftmost zero run on a tie', () => {
    const ip = '2001:db8:0:0:1:0:0:1';
    expect(parseStunMappedAddress(encodeSuccess(TXID, mappedIpv6(ip, 3478)), TXID)).toBe(
      '[2001:db8::1:0:0:1]:3478'
    );
  });

  test('skips SOFTWARE padding to reach XOR-MAPPED-ADDRESS', () => {
    const attrs = concatAttrs(softwareAttr('hello'), xorMappedIpv4('203.0.113.10', 9));
    expect(parseStunMappedAddress(encodeSuccess(TXID, attrs), TXID)).toBe('203.0.113.10:9');
  });

  test('rejects truncated packets and mismatched transaction ids', () => {
    expect(parseStunMappedAddress(new Uint8Array(10), TXID)).toBeNull();
    expect(
      parseStunMappedAddress(encodeSuccess(TXID, new Uint8Array([0, 0x20, 0, 8, 0, 1])), TXID)
    ).toBeNull();
    const other = Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9);
    expect(
      parseStunMappedAddress(encodeSuccess(other, xorMappedIpv4('203.0.113.10', 1)), TXID)
    ).toBeNull();
  });
});

describe('probeStunServer', () => {
  test('returns url error for a non-stun URL without opening a socket', async () => {
    const result = await probeStunServer('not-a-url', {
      createSocket: () => {
        throw new Error('socket should not open');
      },
    });
    expect(result).toMatchObject({ url: 'not-a-url', ok: false, error: 'url' });
  });

  test('skips stuns/turn/turns as unsupported-scheme', async () => {
    const skipped = [
      'stuns:tls.example:5349',
      'turn:relay.example:3478',
      'turns:relay.example:5349',
    ];
    for (const url of skipped) {
      const result = await probeStunServer(url, {
        createSocket: () => {
          throw new Error('socket should not open');
        },
      });
      expect(result).toEqual({ url, ok: false, rttMs: 0, skipped: 'unsupported-scheme' });
    }
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

  test('carries lookup error codes', async () => {
    const result = await probeStunServer('stun:missing.example:3478', {
      lookup: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      },
    });
    expect(result.error).toBe('ENOTFOUND');
  });

  test('exchanges a Binding request and records rtt plus mapped address', async () => {
    const sock = new FakeSocket();
    const clock = { now: 1_000 };
    const pending = probeStunServer('stun:stun.example:3478', {
      lookup: async () => ['203.0.113.50'],
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
      via: 'system',
      fakeIp: false,
    });
    expect(sock.closed).toBe(true);
  });

  test('uses stun-resolver DoH target when system DNS is fake-IP', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:fake.example:3478', {
      lookup: async () => ['198.18.0.24'],
      doh: async () => ['203.0.113.50'],
      createSocket: () => sock,
      randomTxid: () => TXID,
      timeoutMs: 200,
    });
    await sock.waitForSend();
    expect(sock.sent[0]?.address).toBe('203.0.113.50');
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('198.51.100.7', 9)));
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      resolvedIp: '203.0.113.50',
      via: 'doh',
      fakeIp: true,
    });
    expect(sock.closed).toBe(true);
  });

  test('falls back from A to AAAA on ENETUNREACH', async () => {
    const sockets: FakeSocket[] = [];
    const pending = probeStunServer('stun:dual.example:3478', {
      lookup: async () => ['203.0.113.8', '2001:db8::9'],
      createSocket: (family) => {
        const sock = new FakeSocket();
        sockets.push(sock);
        if (family === 4) {
          sock.sendError = Object.assign(new Error('net'), { code: 'ENETUNREACH' });
        } else {
          queueMicrotask(() => {
            const sent = sock.sent[0];
            if (!sent) return;
            sock.emitMessage(encodeSuccess(sent.msg.subarray(8, 20), xorMappedIpv4('1.1.1.1', 1)));
          });
        }
        return sock;
      },
      timeoutMs: 200,
    });
    const result = await pending;
    expect(sockets).toHaveLength(2);
    expect(sockets.every((sock) => sock.closed)).toBe(true);
    expect(result).toMatchObject({ ok: true, resolvedIp: '2001:db8::9' });
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
    expect(sock.closed).toBe(true);
  });

  test('ignores replies from the wrong address or port', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      randomTxid: () => TXID,
      timeoutMs: 30,
    });
    await sock.waitForSend();
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('1.1.1.1', 1)), {
      address: '192.0.2.8',
      port: 3478,
    });
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('1.1.1.1', 1)), {
      address: '192.0.2.9',
      port: 9,
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
    expect(sock.closed).toBe(true);
  });

  test('treats Binding error response 0x0111 as reachable', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      randomTxid: () => TXID,
      timeoutMs: 200,
    });
    await sock.waitForSend();
    sock.emitMessage(encodeBindingError(TXID));
    const result = await pending;
    expect(result).toMatchObject({
      ok: true,
      errorResponse: true,
      resolvedIp: '192.0.2.9',
    });
    expect(result.mappedAddress).toBeUndefined();
    expect(sock.closed).toBe(true);
  });

  test('retransmits Binding with the same txid at RTO then 2×RTO', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      randomTxid: () => TXID,
      timeoutMs: 200,
      rtoMs: 20,
    });
    await sock.waitForSendCount(3);
    expect(sock.sent).toHaveLength(3);
    const encoded = [...encodeBindingRequest(TXID)];
    expect(sock.sent.every((row) => [...row.msg].join() === encoded.join())).toBe(true);
    sock.emitMessage(encodeSuccess(TXID, xorMappedIpv4('1.1.1.1', 1)));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(sock.closed).toBe(true);
  });

  test('carries socket error codes and closes the socket', async () => {
    const sock = new FakeSocket();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      timeoutMs: 200,
    });
    await sock.waitForSend();
    sock.emitError(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const result = await pending;
    expect(result.error).toBe('EACCES');
    expect(sock.closed).toBe(true);
  });

  test('closes the socket on send callback errors', async () => {
    const sock = new FakeSocket();
    sock.sendError = Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
    const result = await probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      timeoutMs: 200,
    });
    expect(result.error).toBe('EADDRINUSE');
    expect(sock.closed).toBe(true);
  });

  test('skips binding when DNS leaves no budget', async () => {
    const clock = { now: 1_000 };
    let opened = 0;
    const result = await probeStunServer('stun:slow.example:3478', {
      lookup: async () => {
        clock.now = 2_950;
        return ['203.0.113.1'];
      },
      createSocket: () => {
        opened += 1;
        return new FakeSocket();
      },
      now: () => clock.now,
      timeoutMs: 2_000,
    });
    expect(opened).toBe(0);
    expect(result.error).toBe('dns-slow');
    expect(result.resolvedIp).toBe('203.0.113.1');
  });

  test('aborts in-flight sockets via AbortSignal', async () => {
    const sock = new FakeSocket();
    const ac = new AbortController();
    const pending = probeStunServer('stun:192.0.2.9:3478', {
      createSocket: () => sock,
      signal: ac.signal,
      timeoutMs: 5_000,
    });
    await sock.waitForSend();
    ac.abort();
    const result = await pending;
    expect(result.error).toBe('aborted');
    expect(sock.closed).toBe(true);
  });

  test('probes several servers concurrently and skips unsupported schemes', async () => {
    const sockets: FakeSocket[] = [];
    const results = await probeStunServers(
      ['stun:a.example:3478', 'stun:b.example:3478', 'not-stun', 'turn:relay.example:3478'],
      {
        lookup: async (hostname) => [hostname === 'a.example' ? '9.9.9.9' : '8.8.8.8'],
        createSocket: () => {
          const sock = new FakeSocket();
          sockets.push(sock);
          queueMicrotask(() => {
            const sent = sock.sent[0];
            if (!sent) return;
            if (sent.address === '9.9.9.9') {
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
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ ok: true, mappedAddress: '1.1.1.1:1' });
    expect(results[1]).toMatchObject({ ok: false, error: 'timeout' });
    expect(results[2]).toMatchObject({ ok: false, error: 'url' });
    expect(results[3]).toMatchObject({ ok: false, skipped: 'unsupported-scheme' });
    expect(sockets.every((sock) => sock.closed)).toBe(true);
  });
});

describe('mesh STUN probe loop', () => {
  test('one-shot plus interval plus list-change re-probe, and withStunProbes snapshot', async () => {
    const calls: string[][] = [];
    loopOpts(async (urls) => {
      calls.push([...urls]);
      return urls.map((url) => ({
        url,
        ok: url.includes('ok'),
        rttMs: 7,
        mappedAddress: url.includes('ok') ? '203.0.113.9:9' : undefined,
        error: url.includes('ok') ? undefined : 'timeout',
      }));
    });
    const ice = { stun: ['stun:ok.example:3478'] };
    const rtc = { currentIceConfig: () => ice };
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    startMeshStunProbe(rtc, {
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
    await flush();
    expect(calls).toEqual([['stun:ok.example:3478'], ['stun:down.example:3478']]);
    expect(stunProbeSnapshot()[0]?.ok).toBe(false);

    timers[0]!.fn();
    await flush();
    expect(calls).toHaveLength(3);

    stopMeshStunProbe();
    expect(timers[0]?.cleared).toBe(true);
  });

  test('stun and probes come from the same effective list', async () => {
    const stun = ['stun:a.example:3478', 'stun:b.example:3478'];
    loopOpts(async (urls) => urls.map((url) => ({ url, ok: true, rttMs: 1 })));
    startMeshStunProbe(
      { currentIceConfig: () => ({ stun }) },
      { interval: () => ({ clear() {} }) }
    );
    await flush();
    const body = withStunProbes({ stun, turn: null });
    expect(body.stun).toEqual(stun);
    expect(body.probes.map((row) => row.url)).toEqual(stun);
  });

  test('change-triggered cycles wait at least 30s', async () => {
    const clock = { now: 1_000 };
    const calls: string[][] = [];
    setStunProbeLoopForTest({
      now: () => clock.now,
      random: () => 0.5,
      minIntervalMs: STUN_PROBE_MIN_INTERVAL_MS,
      probeAll: async (urls) => {
        calls.push([...urls]);
        return urls.map((url) => ({ url, ok: true, rttMs: 1 }));
      },
    });
    const ice = { stun: ['stun:a:1'] };
    const rtc = { currentIceConfig: () => ice };
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    startMeshStunProbe(rtc, {
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
    ice.stun = ['stun:b:1'];
    syncStunProbe(rtc);
    await flush();
    expect(calls).toHaveLength(1);
    const wait = timers.find((row) => row.ms === 20_000);
    expect(wait).toBeTruthy();
    clock.now = 31_000;
    wait!.fn();
    await flush();
    expect(calls).toEqual([['stun:a:1'], ['stun:b:1']]);
  });

  test('10-minute tick is jittered by ±10%', () => {
    setStunProbeLoopForTest({ random: () => 0, probeAll: async () => [] });
    const timers: number[] = [];
    startMeshStunProbe(
      { currentIceConfig: () => ({ stun: [] }) },
      {
        interval(_fn, ms) {
          timers.push(ms);
          return { clear() {} };
        },
      }
    );
    expect(timers[0]).toBe(Math.round(STUN_PROBE_INTERVAL_MS * 0.9));
    resetStunProbeForTest();
    setStunProbeLoopForTest({ random: () => 1, probeAll: async () => [] });
    startMeshStunProbe(
      { currentIceConfig: () => ({ stun: [] }) },
      {
        interval(_fn, ms) {
          timers.push(ms);
          return { clear() {} };
        },
      }
    );
    expect(timers[1]).toBe(Math.round(STUN_PROBE_INTERVAL_MS * 1.1));
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
      loopOpts(async (urls) =>
        urls.map((url) => ({ url, ok: false, rttMs: 2000, error: 'timeout' }))
      );
      startMeshStunProbe(
        { currentIceConfig: () => ({ stun: ['stun:a:1', 'stun:b:1'] }) },
        { interval: () => ({ clear() {} }) }
      );
      await flush();
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

  test('unreachable all= counts only attempted stun URLs', async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.log = () => {};
    console.warn = (line?: unknown) => {
      warns.push(String(line));
    };
    try {
      loopOpts(async (urls) => [
        { url: urls[0] ?? '', ok: false, rttMs: 2000, error: 'timeout' },
        { url: urls[1] ?? '', ok: false, rttMs: 0, skipped: 'unsupported-scheme' },
      ]);
      startMeshStunProbe(
        { currentIceConfig: () => ({ stun: ['stun:a:1', 'stuns:x:1'] }) },
        { interval: () => ({ clear() {} }) }
      );
      await flush();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    expect(warns.some((line) => line.includes('all=1'))).toBe(true);
    expect(warns.some((line) => line.includes('all=2'))).toBe(false);
  });

  test('masks mapped address in logs and omits skipped URLs from all=', async () => {
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
      loopOpts(async (urls) => [
        {
          url: urls[0] ?? '',
          ok: true,
          rttMs: 12,
          mappedAddress: '203.0.113.10:54321',
          via: 'doh',
          fakeIp: true,
        },
        { url: urls[1] ?? '', ok: false, rttMs: 0, skipped: 'unsupported-scheme' },
        { url: urls[2] ?? '', ok: false, rttMs: 2000, error: 'EACCES' },
      ]);
      startMeshStunProbe(
        {
          currentIceConfig: () => ({
            stun: ['stun:ok:3478', 'stuns:x:1', 'stun:down:3478'],
          }),
        },
        { interval: () => ({ clear() {} }) }
      );
      await flush();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    expect(logs.some((line) => line.includes('mapped=203.0.113.0:54321'))).toBe(true);
    expect(logs.some((line) => line.includes('203.0.113.10:54321'))).toBe(false);
    expect(logs.some((line) => line.includes('via=doh') && line.includes('fake_ip=true'))).toBe(
      true
    );
    expect(logs.some((line) => line.includes('skipped=unsupported-scheme'))).toBe(true);
    expect(logs.some((line) => line.includes('error=EACCES'))).toBe(true);
    expect(stunProbeSnapshot()[0]?.mappedAddress).toBe('203.0.113.10:54321');
    expect(warns.some((line) => line.includes('stun unreachable'))).toBe(false);
  });

  test('logging throws do not become unhandled rejections', async () => {
    const origLog = console.log;
    console.log = () => {
      throw new Error('log fail');
    };
    try {
      loopOpts(async (urls) => urls.map((url) => ({ url, ok: true, rttMs: 1 })));
      startMeshStunProbe(
        { currentIceConfig: () => ({ stun: ['stun:a:1'] }) },
        { interval: () => ({ clear() {} }) }
      );
      await flush();
      expect(stunProbeSnapshot()).toHaveLength(1);
    } finally {
      console.log = origLog;
    }
  });

  test('synchronous-firing scheduler does not runaway', async () => {
    setStunProbeLoopForTest({
      now: () => 1,
      random: () => 0.5,
      probeAll: async () => [],
    });
    let intervalCalls = 0;
    const handles: Array<{ fn: () => void; cleared: boolean }> = [];
    startMeshStunProbe(
      { currentIceConfig: () => ({ stun: ['stun:a:1'] }) },
      {
        interval(fn) {
          intervalCalls += 1;
          if (intervalCalls > 4) throw new Error('runaway scheduler.interval');
          const rec = { fn, cleared: false };
          handles.push(rec);
          fn();
          return {
            clear() {
              rec.cleared = true;
            },
          };
        },
      }
    );
    expect(intervalCalls).toBe(1);
    for (const handle of handles) {
      if (!handle.cleared) handle.fn();
    }
    expect(intervalCalls).toBe(1);
    await flush();
    expect(intervalCalls).toBe(1);
    stopMeshStunProbe();
    expect(handles[0]?.cleared).toBe(true);
  });

  test('test env without probeAll skips the network', async () => {
    startMeshStunProbe(
      { currentIceConfig: () => ({ stun: ['stun:example:3478'] }) },
      {
        interval(fn) {
          fn();
          return { clear() {} };
        },
      }
    );
    await flush();
    expect(stunProbeSnapshot()).toEqual([]);
  });
});
