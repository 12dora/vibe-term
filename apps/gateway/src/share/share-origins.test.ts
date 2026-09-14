import { beforeEach, describe, expect, test } from 'bun:test';
import type { RelayProbeState } from './relay-entry-probe';
import {
  type ShareOriginProbe,
  type ShareOriginSources,
  buildShareOriginContext,
  primeShareRelayOrigins,
  relayShareAccessUrl,
  resolveSharePrefix,
  setShareOriginAttachedUplink,
  startShareRelayPriming,
} from './share-origins';

function fakeProbe(states: Record<string, RelayProbeState> = {}): ShareOriginProbe & {
  ensured: string[];
  invalidated: string[];
} {
  const ensured: string[] = [];
  const invalidated: string[] = [];
  const current = { ...states };
  return {
    ensured,
    invalidated,
    state: (url) => current[url] ?? 'unknown',
    ensure: (url) => {
      ensured.push(url);
    },
    invalidate: (url) => {
      invalidated.push(url);
      delete current[url];
    },
  };
}

// 模块内记着「上次观察到的在用中继」，逐个用例复位，免得互相污染。
beforeEach(() => {
  setShareOriginAttachedUplink(null);
});

function sources(overrides: Partial<ShareOriginSources> = {}): ShareOriginSources {
  return {
    localNodeId: () => 'node-a',
    siteUrl: () => null,
    siteUrlManaged: () => false,
    tunnelUrl: () => null,
    baseUrl: () => null,
    uplinkKind: () => 'none',
    relays: () => [],
    relayProbe: () => fakeProbe(),
    ...overrides,
  };
}

describe('buildShareOriginContext', () => {
  test('site / relay / tunnel / ip 全量候选按优先级排序', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://site.example.com',
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
        tunnelUrl: () => 'https://tunnel.example.com',
        baseUrl: () => 'http://203.0.113.7:9663',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['site', 'relay', 'tunnel', 'ip']);
    expect(context.candidates[0]?.label).toBe('site.example.com');
    expect(context.candidates.map((item) => item.accessUrl)).toEqual([
      'https://site.example.com',
      'https://relay.example.com/n/node-a',
      'https://tunnel.example.com',
      'http://203.0.113.7:9663',
    ]);
    expect(context.nodePrefix).toBe('/n/node-a');
  });

  test('中继上联且探测通过：中继候选带 /n/<self> 且排在隧道之前', () => {
    const probe = fakeProbe({ 'https://relay.example.com': 'ok' });
    const context = buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => probe,
        tunnelUrl: () => 'https://tunnel.example.com',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['relay', 'tunnel']);
    expect(context.candidates[0]).toMatchObject({
      url: 'https://relay.example.com',
      accessUrl: 'https://relay.example.com/n/node-a',
    });
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
    expect(probe.ensured).toEqual(['https://relay.example.com']);
  });

  test('中继探测未完成或不可达时不产生候选', () => {
    const relays = () => [
      { url: 'https://relay-a.example.com', priority: 0, attached: true },
      { url: 'https://relay-b.example.com', priority: 1, attached: false },
    ];
    const unknown = buildShareOriginContext(
      sources({ uplinkKind: () => 'relay', relays, relayProbe: () => fakeProbe() })
    );
    expect(unknown.candidates).toEqual([]);

    const bad = buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays,
        relayProbe: () =>
          fakeProbe({ 'https://relay-a.example.com': 'bad', 'https://relay-b.example.com': 'ok' }),
      })
    );
    expect(bad.candidates.map((item) => item.url)).toEqual(['https://relay-b.example.com']);
  });

  test('uplinkKind 为 none 时永远不产生中继候选', () => {
    const context = buildShareOriginContext(
      sources({
        uplinkKind: () => 'none',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(context.candidates.some((item) => item.kind === 'relay')).toBe(false);
  });

  test('站点 URL 就是隧道域名时不重复产出 site 候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://tunnel.example.com',
        tunnelUrl: () => 'https://tunnel.example.com',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['tunnel']);
  });

  test('站点 URL 由运行时托管时不作为 site 候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://relay.example.com/n/node-a',
        siteUrlManaged: () => true,
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['relay']);
  });

  test('站点 URL 等于中继 accessUrl 时不重复产出 site 候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://relay.example.com/n/node-a',
        siteUrlManaged: () => false,
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['relay']);
    expect(context.candidates.filter((item) => item.kind === 'site')).toEqual([]);
  });

  test('站点 URL 等于公网 IP 基址时保留 ip 候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'http://203.0.113.7:9663',
        baseUrl: () => 'http://203.0.113.7:9663',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['ip']);
  });

  test('无关的自建域名仍产出 site 候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://mine.example.com',
        siteUrlManaged: () => false,
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
        tunnelUrl: () => 'https://tunnel.example.com',
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['site', 'relay', 'tunnel']);
    expect(context.candidates[0]).toMatchObject({
      kind: 'site',
      accessUrl: 'https://mine.example.com',
    });
  });

  test('中继探测 bad 时站点 URL 即使等于中继 accessUrl 仍保留', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://relay.example.com/n/node-a',
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'bad' }),
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['site']);
    expect(context.candidates[0]?.accessUrl).toBe('https://relay.example.com/n/node-a');
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('uplinkKind 为 none 时历史中继行同 host 不吞掉站点 URL', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://mine.example.com',
        uplinkKind: () => 'none',
        relays: () => [{ url: 'https://mine.example.com', priority: 0, attached: false }],
        relayProbe: () => fakeProbe({ 'https://mine.example.com': 'ok' }),
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['site']);
    expect(context.candidates[0]?.accessUrl).toBe('https://mine.example.com');
  });

  test('站点 URL 落在中继域名时前缀仍由中继行提供', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'https://relay.example.com',
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['relay']);
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('同一次 build 只读一次 relays', () => {
    let relayReads = 0;
    buildShareOriginContext(
      sources({
        siteUrl: () => 'https://mine.example.com',
        uplinkKind: () => 'relay',
        relays: () => {
          relayReads += 1;
          return [{ url: 'https://relay.example.com', priority: 0, attached: true }];
        },
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(relayReads).toBe(1);
  });

  test('内网 / 回环地址不进候选', () => {
    const context = buildShareOriginContext(
      sources({
        siteUrl: () => 'http://localhost:9663',
        baseUrl: () => 'http://127.0.0.1:9663',
      })
    );
    expect(context.candidates).toEqual([]);
  });

  test('baseUrl 是域名时不算 ip 候选', () => {
    const context = buildShareOriginContext(sources({ baseUrl: () => 'https://box.example.com' }));
    expect(context.candidates).toEqual([]);
  });

  test('自定义地址置顶为 custom，与中继同主机时继承节点前缀', () => {
    const context = buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      }),
      'https://relay.example.com'
    );
    expect(context.candidates[0]).toMatchObject({
      kind: 'custom',
      url: 'https://relay.example.com',
      accessUrl: 'https://relay.example.com/n/node-a',
    });
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('自定义地址与中继同主机时同样继承节点前缀', () => {
    const context = buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      }),
      'https://relay.example.com/'
    );
    expect(context.candidates[0]).toMatchObject({
      kind: 'custom',
      accessUrl: 'https://relay.example.com/n/node-a',
    });
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('自定义独立域名不带节点前缀', () => {
    const context = buildShareOriginContext(sources(), 'https://custom.example.com/');
    expect(context.candidates[0]?.kind).toBe('custom');
    expect(context.candidates[0]?.accessUrl).toBe('https://custom.example.com');
    expect(resolveSharePrefix(context, 'https://custom.example.com')).toBeNull();
  });

  test('没有节点身份时 nodePrefix 为 null，中继候选也不产出', () => {
    const context = buildShareOriginContext(
      sources({
        localNodeId: () => null,
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'ok' }),
      })
    );
    expect(context.nodePrefix).toBeNull();
    expect(context.candidates).toEqual([]);
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBeNull();
  });
});

describe('中继前缀与探测状态解耦', () => {
  const relays = () => [{ url: 'https://relay.example.com', priority: 0, attached: true }];

  test('探测未完成时中继不进候选，但前缀映射照给', () => {
    const context = buildShareOriginContext(
      sources({ uplinkKind: () => 'relay', relays, relayProbe: () => fakeProbe() })
    );
    expect(context.candidates).toEqual([]);
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('探测已过期时保存的中继默认地址仍带 /n/<self>', () => {
    const context = buildShareOriginContext(
      sources({ uplinkKind: () => 'relay', relays, relayProbe: () => fakeProbe() }),
      'https://relay.example.com'
    );
    expect(context.candidates[0]).toMatchObject({
      kind: 'custom',
      accessUrl: 'https://relay.example.com/n/node-a',
    });
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });

  test('探测 bad 时中继不在候选里，同主机的自定义地址仍继承前缀', () => {
    const context = buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays,
        relayProbe: () => fakeProbe({ 'https://relay.example.com': 'bad' }),
      }),
      'https://relay.example.com'
    );
    expect(context.candidates.map((item) => item.kind)).toEqual(['custom']);
    expect(resolveSharePrefix(context, 'https://relay.example.com')).toBe('/n/node-a');
  });
});

describe('在用中继变化时作废探测缓存', () => {
  test('从未接上到接上：invalidate 后重新 ensure', () => {
    const probe = fakeProbe({ 'https://relay-a.example.com': 'bad' });
    const detached = sources({
      uplinkKind: () => 'relay',
      relays: () => [{ url: 'https://relay-a.example.com', priority: 0, attached: false }],
      relayProbe: () => probe,
    });
    buildShareOriginContext(detached);
    expect(probe.invalidated).toEqual([]);

    const attached = sources({
      uplinkKind: () => 'relay',
      relays: () => [{ url: 'https://relay-a.example.com', priority: 0, attached: true }],
      relayProbe: () => probe,
    });
    buildShareOriginContext(attached);
    expect(probe.invalidated).toEqual(['https://relay-a.example.com']);
    expect(probe.state('https://relay-a.example.com')).toBe('unknown');
    expect(probe.ensured.at(-1)).toBe('https://relay-a.example.com');

    buildShareOriginContext(attached);
    expect(probe.invalidated).toEqual(['https://relay-a.example.com']);
  });

  test('primeShareRelayOrigins 同样在切换中继时作废旧结论', () => {
    const probe = fakeProbe({
      'https://relay-a.example.com': 'bad',
      'https://relay-b.example.com': 'bad',
    });
    const relayRows = [
      { url: 'https://relay-a.example.com', priority: 0, attached: true },
      { url: 'https://relay-b.example.com', priority: 1, attached: false },
    ];
    primeShareRelayOrigins(
      sources({ uplinkKind: () => 'relay', relays: () => relayRows, relayProbe: () => probe })
    );
    expect(probe.invalidated).toEqual(['https://relay-a.example.com']);

    const switched = [
      { url: 'https://relay-b.example.com', priority: 1, attached: true },
      { url: 'https://relay-a.example.com', priority: 0, attached: false },
    ];
    primeShareRelayOrigins(
      sources({ uplinkKind: () => 'relay', relays: () => switched, relayProbe: () => probe })
    );
    expect(probe.invalidated).toEqual([
      'https://relay-a.example.com',
      'https://relay-b.example.com',
    ]);
  });

  test('同一条在用中继的 node 角色变化时作废探测（含 ok）', () => {
    const probe = fakeProbe({ 'https://relay.example.com': 'ok' });
    const src = (node: boolean) =>
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true, node }],
        relayProbe: () => probe,
      });
    buildShareOriginContext(src(false));
    expect(probe.invalidated).toEqual([]);

    buildShareOriginContext(src(true));
    expect(probe.invalidated).toEqual(['https://relay.example.com']);
    expect(probe.state('https://relay.example.com')).toBe('unknown');

    buildShareOriginContext(src(true));
    expect(probe.invalidated).toEqual(['https://relay.example.com']);
  });

  test('同一条在用中继公网 URL 变化时作废新地址上的 bad', () => {
    const probe = fakeProbe({
      'https://relay-old.example.com': 'ok',
      'https://relay-new.example.com': 'bad',
    });
    buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay-old.example.com', priority: 0, attached: true }],
        relayProbe: () => probe,
      })
    );
    expect(probe.invalidated).toEqual([]);

    buildShareOriginContext(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay-new.example.com', priority: 0, attached: true }],
        relayProbe: () => probe,
      })
    );
    expect(probe.invalidated).toEqual(['https://relay-new.example.com']);
  });
});

describe('startShareRelayPriming', () => {
  test('不同步预热（装配期探测必失败），返回的清理函数可撤销定时器', () => {
    const probe = fakeProbe();
    const stop = startShareRelayPriming(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
        relayProbe: () => probe,
      })
    );
    expect(probe.ensured).toEqual([]);
    stop();
    expect(probe.ensured).toEqual([]);
  });
});

describe('relayShareAccessUrl', () => {
  const relaySources = (state: RelayProbeState) =>
    sources({
      uplinkKind: () => 'relay',
      relays: () => [{ url: 'https://relay.example.com', priority: 0, attached: true }],
      relayProbe: () => fakeProbe({ 'https://relay.example.com': state }),
    });

  test('探测通过时给出 <relay>/n/<self>，未通过时为 null', () => {
    expect(relayShareAccessUrl(relaySources('ok'), 1_000)).toBe(
      'https://relay.example.com/n/node-a'
    );
    expect(relayShareAccessUrl(relaySources('bad'), 100_000)).toBeNull();
    expect(relayShareAccessUrl(sources(), 200_000)).toBeNull();
  });

  test('5 s 内记忆化，避免每次读站点设置都重建候选', () => {
    expect(relayShareAccessUrl(relaySources('ok'), 300_000)).toBe(
      'https://relay.example.com/n/node-a'
    );
    expect(relayShareAccessUrl(relaySources('bad'), 302_000)).toBe(
      'https://relay.example.com/n/node-a'
    );
    expect(relayShareAccessUrl(relaySources('bad'), 310_000)).toBeNull();
  });
});

describe('primeShareRelayOrigins', () => {
  test('中继上联时预热所有中继入口，none 时不动', () => {
    const relayProbe = fakeProbe();
    primeShareRelayOrigins(
      sources({
        uplinkKind: () => 'relay',
        relays: () => [
          { url: 'https://relay-a.example.com', priority: 0, attached: true },
          { url: 'https://relay-b.example.com', priority: 1, attached: false },
        ],
        relayProbe: () => relayProbe,
      })
    );
    expect(relayProbe.ensured).toEqual([
      'https://relay-a.example.com',
      'https://relay-b.example.com',
    ]);

    const idleProbe = fakeProbe();
    primeShareRelayOrigins(
      sources({
        uplinkKind: () => 'none',
        relays: () => [{ url: 'https://relay-a.example.com', priority: 0, attached: true }],
        relayProbe: () => idleProbe,
      })
    );
    expect(idleProbe.ensured).toEqual([]);
  });
});
