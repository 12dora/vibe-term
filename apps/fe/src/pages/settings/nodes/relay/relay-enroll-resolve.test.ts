// 接入中继前的端口探测：显式端口不动，探到端口就用探到的，探不动就沿用用户输入。

import { describe, expect, test } from 'bun:test';
import type { RelayResolveResult, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { resolveEnrollUrl } from './use-relay-actions';

function api(impl: (url: string) => Promise<RelayResolveResult>, calls: string[] = []) {
  return {
    calls,
    relayApi: {
      resolveRelayAddress: (url: string) => {
        calls.push(url);
        return impl(url);
      },
    } as unknown as RelayTenantApi,
  };
}

const found = (url: string, port: number): RelayResolveResult => ({
  url,
  port,
  explicit: false,
  triedPorts: [443, port],
});

describe('resolveEnrollUrl', () => {
  test('地址没写端口时先探，探到的带端口地址接着用', async () => {
    const { relayApi, calls } = api(async () => found('https://relay.example.com:13443', 13443));
    expect(await resolveEnrollUrl(relayApi, 'https://relay.example.com')).toBe(
      'https://relay.example.com:13443'
    );
    expect(calls).toEqual(['https://relay.example.com']);
  });

  test('用户写了端口就不探——proof 签的是含端口的 host，不能事后改', async () => {
    const { relayApi, calls } = api(async () => found('https://relay.example.com:8443', 8443));
    expect(await resolveEnrollUrl(relayApi, 'https://relay.example.com:13443')).toBe(
      'https://relay.example.com:13443'
    );
    expect(calls).toEqual([]);
  });

  test('回环地址不探', async () => {
    const { relayApi, calls } = api(async () => found('http://localhost:9883', 9883));
    expect(await resolveEnrollUrl(relayApi, 'http://localhost')).toBe('http://localhost');
    expect(calls).toEqual([]);
  });

  test('一个端口都没答话：沿用用户输入，由后续步骤报真正的原因', async () => {
    const { relayApi } = api(async () => ({
      url: null,
      port: null,
      explicit: false,
      triedPorts: [443],
    }));
    expect(await resolveEnrollUrl(relayApi, 'https://relay.example.com')).toBe(
      'https://relay.example.com'
    );
  });

  test('旧节点没有这条路由（抛错）也沿用用户输入', async () => {
    const { relayApi } = api(() => Promise.reject(new Error('404')));
    expect(await resolveEnrollUrl(relayApi, 'https://relay.example.com')).toBe(
      'https://relay.example.com'
    );
  });
});
