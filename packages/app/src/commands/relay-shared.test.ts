import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../lib/fetch-like';
import {
  RELAY_RESPONSE_MAX_BYTES,
  RelayApiError,
  RelayTimeoutError,
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
