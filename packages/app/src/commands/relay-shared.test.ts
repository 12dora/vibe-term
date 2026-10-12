import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../lib/fetch-like';
import {
  RELAY_RESPONSE_MAX_BYTES,
  RelayApiError,
  RelayTimeoutError,
  RelayTransportError,
  formatLimits,
  formatQuota,
  gatewayBaseUrl,
  limitsFromJson,
  loopbackHost,
  parseBandwidthFlag,
  parseCountFlag,
  parseFairShareFlag,
  parseMaxFileFlag,
  parseMaxTenantsFlag,
  parseTotalBandwidthFlag,
  requestRelayJson,
} from './relay-shared';

describe('gateway loopback host', () => {
  test('falls back to IPv4 loopback', () => {
    expect(loopbackHost({})).toBe('127.0.0.1');
    expect(loopbackHost({ VIBETERM_BIND_HOST: '0.0.0.0' })).toBe('127.0.0.1');
    expect(loopbackHost({ VIBETERM_BIND_HOST: 'localhost' })).toBe('127.0.0.1');
  });

  test('uses the IPv6 loopback when the instance binds an IPv6 literal', () => {
    expect(loopbackHost({ VIBETERM_BIND_HOST: '::' })).toBe('[::1]');
    expect(loopbackHost({ VIBETERM_BIND_HOST: '[::]' })).toBe('[::1]');
    expect(loopbackHost({ VIBETERM_BIND_HOST: '::1' })).toBe('[::1]');
    expect(gatewayBaseUrl({ GATEWAY_PORT: '9883', VIBETERM_BIND_HOST: '::' })).toBe(
      'http://[::1]:9883'
    );
  });
});

describe('relay quota flags', () => {
  test('matches the server range for counts', () => {
    expect(parseCountFlag('4', 'max-nodes')).toBe(4);
    expect(() => parseCountFlag('0', 'max-nodes')).toThrow('1..256');
    expect(() => parseCountFlag('257', 'max-nodes')).toThrow('1..256');
    expect(() => parseCountFlag('0', 'max-streams')).toThrow('1..65536');
    expect(() => parseCountFlag('65537', 'max-streams')).toThrow('1..65536');
    expect(() => parseCountFlag('-1', 'max-nodes')).toThrow('positive integer');
  });

  test('rejects a bandwidth that would round-trip to unlimited', () => {
    expect(parseBandwidthFlag('unlimited')).toBeNull();
    expect(parseBandwidthFlag('0')).toBeNull();
    expect(parseBandwidthFlag('512')).toBe(512 * 1024);
    // 1e400 → Infinity → JSON 里变 null（= 不限速），必须在客户端就拦下。
    expect(() => parseBandwidthFlag('999999999999999999999999')).toThrow('invalid --bandwidth');
    expect(() => parseBandwidthFlag('10485761')).toThrow('invalid --bandwidth');
  });

  test('--max-file-mb：none/0 表示不限，其余按 MB 折算并卡上限', () => {
    expect(parseMaxFileFlag('none')).toBeNull();
    expect(parseMaxFileFlag('unlimited')).toBeNull();
    expect(parseMaxFileFlag('0')).toBeNull();
    expect(parseMaxFileFlag('100')).toBe(100 * 1024 * 1024);
    expect(() => parseMaxFileFlag('1.5')).toThrow('invalid --max-file-mb');
    expect(() => parseMaxFileFlag('1048577')).toThrow('invalid --max-file-mb');
  });

  test('配额摘要带单文件上限', () => {
    expect(
      formatQuota({ maxNodes: 4, maxStreams: 8, bandwidthBytesPerSec: null, maxFileBytes: null })
    ).toBe('nodes=4 streams=8 bw=unlimited file=unlimited');
    expect(
      formatQuota({
        maxNodes: 4,
        maxStreams: 8,
        bandwidthBytesPerSec: 524_288,
        maxFileBytes: 100 * 1024 * 1024,
      })
    ).toBe('nodes=4 streams=8 bw=512 KB/s file=100 MB');
  });
});

describe('relay limits flags', () => {
  test('none/0 表示不限，其余卡在服务端区间内', () => {
    expect(parseMaxTenantsFlag('none')).toBeNull();
    expect(parseMaxTenantsFlag('0')).toBeNull();
    expect(parseMaxTenantsFlag('4')).toBe(4);
    expect(() => parseMaxTenantsFlag('65537')).toThrow('invalid --max-tenants');
    expect(() => parseMaxTenantsFlag('many')).toThrow('invalid --max-tenants');

    expect(parseTotalBandwidthFlag('none')).toBeNull();
    expect(parseTotalBandwidthFlag('512')).toBe(512 * 1024);
    expect(() => parseTotalBandwidthFlag('10485761')).toThrow('invalid --total-bandwidth-kb');

    expect(parseFairShareFlag('on')).toBe(true);
    expect(parseFairShareFlag('OFF')).toBe(false);
    expect(() => parseFairShareFlag('maybe')).toThrow('invalid --fair-share');
  });

  test('limitsFromJson 缺字段按「不限 + 公平分配开」兜底', () => {
    expect(limitsFromJson(undefined)).toEqual({
      maxTenants: null,
      totalBandwidthBytesPerSec: null,
      fairShare: true,
    });
    expect(
      limitsFromJson({ maxTenants: 2, totalBandwidthBytesPerSec: 1024, fairShare: false })
    ).toEqual({ maxTenants: 2, totalBandwidthBytesPerSec: 1024, fairShare: false });
    expect(
      formatLimits({ maxTenants: null, totalBandwidthBytesPerSec: null, fairShare: true })
    ).toBe('tenants=unlimited bw=unlimited fair-share=on');
  });
});

describe('requestRelayJson', () => {
  test('aborts a relay that accepts but never answers', async () => {
    let aborted = false;
    const fetcher: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const started = Date.now();
    const error = await requestRelayJson({
      fetcher,
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
      timeoutMs: 25,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayTimeoutError);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // 超时不是 RelayApiError，所以 r3 的 failover 会换下一台中继。
    expect(error).not.toBeInstanceOf(RelayApiError);
  });

  test('wraps a failing fetch into a transport error that keeps the cause', async () => {
    const cause = new TypeError('Unable to connect');
    const error = await requestRelayJson({
      fetcher: async () => {
        throw cause;
      },
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayTransportError);
    expect((error as Error).message).toBe('relay health failed: Unable to connect');
    expect((error as Error).cause).toBe(cause);
  });

  test('a response body cut mid-read is a transport error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket closed'));
      },
    });
    const error = await requestRelayJson({
      fetcher: async () => new Response(body, { status: 200 }),
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayTransportError);
    expect((error as Error).message).toContain('response could not be read');
  });

  test('an oversized body is not a transport error', async () => {
    const error = await requestRelayJson({
      fetcher: async () => new Response('x'.repeat(64), { status: 200 }),
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
      maxBytes: 8,
    }).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(RelayTransportError);
    expect((error as Error).message).toContain('exceeds 8 bytes');
  });

  test('an external abort cancels the in-flight request and leaves no timer behind', async () => {
    const controller = new AbortController();
    let aborted = false;
    const fetcher: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const pending = requestRelayJson({
      fetcher,
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
      timeoutMs: 60_000,
      signal: controller.signal,
    }).catch((err: unknown) => err);
    controller.abort();
    const error = await pending;
    expect(aborted).toBe(true);
    expect(error).not.toBeInstanceOf(RelayTransportError);
  });

  test('an already aborted signal never reaches the network as a transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher: FetchLike = (_url, init) =>
      Promise.reject(new Error(init?.signal?.aborted ? 'aborted' : 'not aborted'));
    const error = await requestRelayJson({
      fetcher,
      url: 'https://relay.example/api/relay/health',
      label: 'relay health',
      signal: controller.signal,
    }).catch((err: unknown) => err);
    expect((error as Error).message).toBe('aborted');
  });

  test('clears the timer on a normal response', async () => {
    const fetcher: FetchLike = async () => Response.json({ ok: true });
    expect(
      await requestRelayJson({
        fetcher,
        url: 'https://relay.example/api/relay/health',
        label: 'relay health',
        timeoutMs: 50,
      })
    ).toEqual({ ok: true });
    // 计时器没清掉的话，进程会被这个 25ms 的等待之后的 abort 再唤醒一次。
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  test('refuses a body larger than the cap', async () => {
    const fetcher: FetchLike = async () =>
      new Response(`{"pad":"${'x'.repeat(RELAY_RESPONSE_MAX_BYTES + 16)}"}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      requestRelayJson({
        fetcher,
        url: 'https://relay.example/api/relay/health',
        label: 'relay health',
      })
    ).rejects.toThrow('exceeds');
  });

  test('a large error body is capped too', async () => {
    const fetcher: FetchLike = async () =>
      new Response(`{"pad":"${'x'.repeat(RELAY_RESPONSE_MAX_BYTES + 16)}"}`, {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      requestRelayJson({
        fetcher,
        url: 'https://relay.example/api/relay/health',
        label: 'relay health',
      })
    ).rejects.toThrow('exceeds');
  });
});
