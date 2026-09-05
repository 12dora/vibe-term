import { describe, expect, test } from 'bun:test';
import {
  type ShareOriginSources,
  buildShareOriginContext,
  resolveSharePrefix,
} from './share-origins';

function sources(overrides: Partial<ShareOriginSources> = {}): ShareOriginSources {
  return {
    localNodeId: () => 'node-a',
    hubs: () => [],
    siteUrl: () => null,
    tunnelUrl: () => null,
    baseUrl: () => null,
    ...overrides,
  };
}

describe('buildShareOriginContext', () => {
  test('site / hub / tunnel / ip 全量候选按优先级排序', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://site.example.com',
        hubs: () => [{ hubNodeId: 'hub-1', publicUrl: 'https://hub.example.com', name: null }],
        tunnelUrl: () => 'https://tunnel.example.com',
        baseUrl: () => 'http://203.0.113.7:9663',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['site', 'hub', 'tunnel', 'ip']);
    expect(context.candidates[0]?.label).toBe('site.example.com');
    expect(context.nodePrefix).toBe('/n/node-a');
  });

  test('经他人 hub 的候选带节点前缀，本机即 hub 时无前缀', () => {
    const context = buildShareOriginContext(
      sources({
        hubs: () => [
          { hubNodeId: 'hub-1', publicUrl: 'https://hub1.example.com', name: null },
          { hubNodeId: 'node-a', publicUrl: 'https://self-hub.example.com', name: null },
        ],
      })
    );
    expect(resolveSharePrefix(context, 'https://hub1.example.com')).toBe('/n/node-a');
    expect(resolveSharePrefix(context, 'https://self-hub.example.com')).toBeNull();
    expect(resolveSharePrefix(context, 'https://unknown.example.com')).toBeNull();
  });

  test('不产生 relay 候选', () => {
    const context = buildShareOriginContext(sources({ siteUrl: () => 'https://site.example.com' }));
    expect(context.candidates.some((item) => item.kind === 'relay')).toBe(false);
  });

  test('内网 / 回环地址不进候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'http://localhost:9663',
        hubs: () => [{ hubNodeId: 'hub-1', publicUrl: 'http://192.168.1.5', name: null }],
        baseUrl: () => 'http://127.0.0.1:9663',
      })
    );
    expect(context.candidates).toEqual([]);
  });

  test('baseUrl 是域名时不算 ip 候选', () => {
    const context = buildShareOriginContext(sources({ baseUrl: () => 'https://box.example.com' }));
    expect(context.candidates).toEqual([]);
  });

  test('自定义地址置顶为 custom，与 hub 同主机时继承节点前缀', () => {
    const context = buildShareOriginContext(
      sources({
        hubs: () => [{ hubNodeId: 'hub-1', publicUrl: 'https://hub.example.com', name: null }],
      }),
      'https://hub.example.com'
    );
    expect(context.candidates[0]).toMatchObject({
      kind: 'custom',
      url: 'https://hub.example.com',
    });
    expect(resolveSharePrefix(context, 'https://hub.example.com')).toBe('/n/node-a');
  });

  test('自定义独立域名不带节点前缀', () => {
    const context = buildShareOriginContext(sources(), 'https://custom.example.com/');
    expect(context.candidates[0]?.kind).toBe('custom');
    expect(resolveSharePrefix(context, 'https://custom.example.com')).toBeNull();
  });

  test('没有节点身份时 nodePrefix 为 null', () => {
    const context = buildShareOriginContext(
      sources({
        localNodeId: () => null,
        hubs: () => [{ hubNodeId: 'hub-1', publicUrl: 'https://hub.example.com', name: null }],
      })
    );
    expect(context.nodePrefix).toBeNull();
    expect(resolveSharePrefix(context, 'https://hub.example.com')).toBeNull();
  });
});
