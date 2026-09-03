import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../lib/fetch-like';
import {
  RELAY_RESPONSE_MAX_BYTES,
  RelayApiError,
  RelayTimeoutError,
  gatewayBaseUrl,
  loopbackHost,
  parseBandwidthFlag,
  parseCountFlag,
  requestRelayJson,
} from './relay-shared';

describe('gateway loopback host', () => {
  test('falls back to IPv4 loopback', () => {
    expect(loopbackHost({})).toBe('127.0.0.1');
    expect(loopbackHost({ TMEX_BIND_HOST: '0.0.0.0' })).toBe('127.0.0.1');
    expect(loopbackHost({ TMEX_BIND_HOST: 'localhost' })).toBe('127.0.0.1');
  });

  test('uses the IPv6 loopback when the instance binds an IPv6 literal', () => {
    expect(loopbackHost({ TMEX_BIND_HOST: '::' })).toBe('[::1]');
    expect(loopbackHost({ TMEX_BIND_HOST: '[::]' })).toBe('[::1]');
    expect(loopbackHost({ TMEX_BIND_HOST: '::1' })).toBe('[::1]');
    expect(gatewayBaseUrl({ GATEWAY_PORT: '9883', TMEX_BIND_HOST: '::' })).toBe(
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
