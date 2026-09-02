import { describe, expect, test } from 'bun:test';
import type {
  AccessAddressesResponse,
  TunnelProcessState,
  TunnelStatusResponse,
} from '@tmex/shared';
import { buildAccessAddresses, isLoopbackOrigin, showLoopbackHint } from './access-addresses';

/**
 * 隧道状态夹具：进程状态与连接器健康都按真实契约给，排序要认它们。
 * 缺省是「进程在跑、连接器有一条边缘连接」，即一条真正可用的隧道。
 */
function tunnel(
  config: Partial<TunnelStatusResponse['config']>,
  options: {
    publicUrl?: string | null;
    state?: TunnelProcessState;
    readyConnections?: number | null;
    reachable?: boolean | null;
  } = {}
) {
  const {
    publicUrl = null,
    state = 'running',
    readyConnections = 1,
    reachable = readyConnections === null ? null : true,
  } = options;
  return {
    config: { mode: 'off', hostname: null, ...config },
    process: { state, publicUrl },
    connector: { reachable, readyConnections },
  } as unknown as TunnelStatusResponse;
}

const lan: AccessAddressesResponse = {
  bindHost: '0.0.0.0',
  port: 9883,
  loopbackOnly: false,
  lanAddresses: ['192.168.1.20', '10.0.0.5'],
};

describe('buildAccessAddresses', () => {
  test('隧道 → Hub → 局域网 → 当前地址，去重去尾斜杠（隧道与 Hub 同址时留隧道）', () => {
    const list = buildAccessAddresses({
      origin: 'http://192.168.1.20:9883',
      tunnel: tunnel({ mode: 'named', hostname: 'tmex.example.com' }),
      hubPublicUrl: 'https://tmex.example.com/',
      addresses: lan,
    });
    expect(list).toEqual([
      { kind: 'tunnel', url: 'https://tmex.example.com' },
      { kind: 'lan', url: 'http://192.168.1.20:9883' },
      { kind: 'lan', url: 'http://10.0.0.5:9883' },
    ]);
  });

  test('临时隧道用 trycloudflare 地址；回环 origin 不进列表', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({ mode: 'quick' }, { publicUrl: 'https://abc.trycloudflare.com' }),
      hubPublicUrl: null,
      addresses: { ...lan, loopbackOnly: true, lanAddresses: [] },
    });
    expect(list).toEqual([{ kind: 'tunnel', url: 'https://abc.trycloudflare.com' }]);
  });

  test('只有 Hub 公开地址时按 hub 归类，排在局域网之前', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({}),
      hubPublicUrl: 'https://hub.example.com',
      addresses: lan,
    });
    expect(list).toEqual([
      { kind: 'hub', url: 'https://hub.example.com' },
      { kind: 'lan', url: 'http://192.168.1.20:9883' },
      { kind: 'lan', url: 'http://10.0.0.5:9883' },
    ]);
  });

  test('隧道进程已停：地址不摆出来，默认落到局域网', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({ mode: 'named', hostname: 'tmex.example.com' }, { state: 'stopped' }),
      hubPublicUrl: null,
      addresses: lan,
    });
    expect(list).toEqual([
      { kind: 'lan', url: 'http://192.168.1.20:9883' },
      { kind: 'lan', url: 'http://10.0.0.5:9883' },
    ]);
  });

  test('连接器没有边缘连接：隧道降到 Hub / 局域网之后，不当默认', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({ mode: 'named', hostname: 'tmex.example.com' }, { readyConnections: 0 }),
      hubPublicUrl: 'https://hub.example',
      addresses: lan,
    });
    expect(list).toEqual([
      { kind: 'hub', url: 'https://hub.example' },
      { kind: 'lan', url: 'http://192.168.1.20:9883' },
      { kind: 'lan', url: 'http://10.0.0.5:9883' },
      { kind: 'tunnel', url: 'https://tmex.example.com' },
    ]);
  });

  test('进程自报 degraded 同样降级', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({ mode: 'named', hostname: 'tmex.example.com' }, { state: 'degraded' }),
      hubPublicUrl: null,
      addresses: lan,
    });
    expect(list.map((item) => item.kind)).toEqual(['lan', 'lan', 'tunnel']);
  });

  test('读不到连接器 metrics 不算掉线：隧道照旧排第一', () => {
    const list = buildAccessAddresses({
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel(
        { mode: 'named', hostname: 'tmex.example.com' },
        { readyConnections: null, reachable: null }
      ),
      hubPublicUrl: null,
      addresses: lan,
    });
    expect(list[0]).toEqual({ kind: 'tunnel', url: 'https://tmex.example.com' });
  });

  test('什么都没有时退回当前 origin 并给回环提示', () => {
    const input = {
      origin: 'http://127.0.0.1:9883',
      tunnel: tunnel({}),
      hubPublicUrl: null,
      addresses: { ...lan, bindHost: '127.0.0.1', loopbackOnly: true, lanAddresses: [] },
    };
    const list = buildAccessAddresses(input);
    expect(list).toEqual([{ kind: 'current', url: 'http://127.0.0.1:9883' }]);
    expect(showLoopbackHint(list, input)).toBe(true);
  });

  test('数据未到时按 origin 兜底；非回环 origin 不提示', () => {
    const input = {
      origin: 'https://tmex.lan:9883',
      tunnel: null,
      hubPublicUrl: null,
      addresses: null,
    };
    const list = buildAccessAddresses(input);
    expect(list).toEqual([{ kind: 'current', url: 'https://tmex.lan:9883' }]);
    expect(showLoopbackHint(list, input)).toBe(false);
  });

  test('isLoopbackOrigin', () => {
    expect(isLoopbackOrigin('http://localhost:19883')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:19883')).toBe(true);
    expect(isLoopbackOrigin('http://10.1.1.1')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });
});
