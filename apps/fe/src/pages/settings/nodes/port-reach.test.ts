import { describe, expect, test } from 'bun:test';
import { coalesceTurnSpecs, formatPortList } from '@vibeterm/shared/net';
import {
  asPortRole,
  blockedPortReaches,
  formatPortReach,
  parsePortPlan,
  parsePortReachList,
  portPlanFromStatus,
  portPlanOrFallback,
  reachForPlanSpec,
  reachForSpec,
} from './port-reach';

describe('parsePortReachList', () => {
  test('字段缺失是 undefined，不是空数组', () => {
    expect(parsePortReachList(undefined)).toBeUndefined();
    expect(parsePortReachList(null)).toBeUndefined();
    expect(parsePortReachList({})).toBeUndefined();
    expect(parsePortReachList([])).toEqual([]);
  });

  test('只收下形状对的条目', () => {
    expect(
      parsePortReachList([
        { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' },
        { purpose: 'nope', proto: 'tcp', port: 1, status: 'open' },
        {
          purpose: 'rtc-ice',
          proto: 'udp',
          range: { begin: 40000, end: 40099 },
          status: 'unknown',
        },
      ])
    ).toEqual([
      { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' },
      {
        purpose: 'rtc-ice',
        proto: 'udp',
        range: { begin: 40000, end: 40099 },
        status: 'unknown',
      },
    ]);
  });

  test('保留 blocked 原因码', () => {
    expect(
      parsePortReachList([
        {
          purpose: 'peer-signaling',
          proto: 'tcp',
          port: 39001,
          status: 'blocked',
          code: 'peer_refused',
          checkedAt: 42,
        },
        { purpose: 'rtc-ice', proto: 'udp', status: 'blocked', code: 'nope' },
      ])
    ).toEqual([
      {
        purpose: 'peer-signaling',
        proto: 'tcp',
        port: 39001,
        status: 'blocked',
        code: 'peer_refused',
        checkedAt: 42,
      },
      { purpose: 'rtc-ice', proto: 'udp', status: 'blocked' },
    ]);
  });
});

describe('reachForSpec', () => {
  const ports = [
    {
      purpose: 'peer-signaling' as const,
      proto: 'tcp' as const,
      port: 39001,
      status: 'open' as const,
    },
    {
      purpose: 'rtc-ice' as const,
      proto: 'udp' as const,
      range: { begin: 40000, end: 40099 },
      status: 'unknown' as const,
    },
  ];

  test('purpose+port 对上才返回；对不上当没有', () => {
    expect(
      reachForSpec(ports, { purpose: 'peer-signaling', proto: 'tcp', port: 39001 })?.status
    ).toBe('open');
    expect(
      reachForSpec(ports, { purpose: 'peer-signaling', proto: 'tcp', port: 39002 })
    ).toBeUndefined();
    expect(
      reachForSpec(ports, { purpose: 'public-https', proto: 'tcp', port: 443 })
    ).toBeUndefined();
    expect(
      reachForSpec(undefined, { purpose: 'peer-signaling', proto: 'tcp', port: 39001 })
    ).toBeUndefined();
  });

  test('proto 不同或 reach 缺端口不算对上', () => {
    expect(
      reachForSpec(ports, { purpose: 'peer-signaling', proto: 'udp', port: 39001 })
    ).toBeUndefined();
    const noPort = [
      { purpose: 'peer-signaling' as const, proto: 'tcp' as const, status: 'blocked' as const },
    ];
    expect(
      reachForSpec(noPort, { purpose: 'peer-signaling', proto: 'tcp', port: 39001 })
    ).toBeUndefined();
  });

  test('range 对上才算 rtc-ice', () => {
    expect(
      reachForSpec(ports, { purpose: 'rtc-ice', proto: 'udp', range: { begin: 40000, end: 40099 } })
        ?.status
    ).toBe('unknown');
    expect(
      reachForSpec(ports, { purpose: 'rtc-ice', proto: 'udp', range: { begin: 40050, end: 40099 } })
    ).toBeUndefined();
  });
});

describe('blockedPortReaches', () => {
  test('只挑 blocked；缺失或全 unknown 得到空', () => {
    expect(blockedPortReaches(undefined)).toEqual([]);
    expect(
      blockedPortReaches([
        { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'unknown' },
      ])
    ).toEqual([]);
    expect(
      formatPortReach({
        purpose: 'peer-signaling',
        proto: 'tcp',
        port: 39001,
      })
    ).toBe('39001/tcp');
  });
});

describe('portPlanFromStatus', () => {
  test('字段缺失才退回 fallback；空数组原样用', () => {
    expect(portPlanFromStatus(null)).toBeUndefined();
    expect(portPlanFromStatus({})).toBeUndefined();
    expect(portPlanFromStatus({ portPlan: [] })).toEqual([]);
    const plan = parsePortPlan([
      { purpose: 'peer-signaling', proto: 'tcp', port: 39002, required: true },
    ]);
    expect(portPlanFromStatus({ portPlan: plan })).toEqual(plan);
    expect(portPlanOrFallback(undefined, 'node').map((s) => s.purpose)).toEqual([
      'peer-signaling',
      'rtc-ice',
    ]);
    expect(asPortRole('relay,node', 'node')).toBe('relay,node');
    expect(asPortRole('whatever', 'node')).toBe('node');
    expect(asPortRole('hub,node', 'node')).toBe('node');
    expect(formatPortList(portPlanOrFallback(undefined, 'relay'))).toBe(
      '443/tcp, 40000/udp, 40001-40049/udp'
    );
    expect(formatPortList(portPlanOrFallback(undefined, 'relay,node'))).toBe(
      '443/tcp, 39001/tcp, 40050-40099/udp, 40000/udp, 40001-40049/udp'
    );
    expect(formatPortList(portPlanOrFallback(undefined, 'node'))).toBe(
      '39001/tcp, 40000-40099/udp'
    );
  });
});

describe('reachForPlanSpec', () => {
  const turnReach = (status: 'open' | 'blocked' | 'unknown') => [
    {
      purpose: 'turn-control' as const,
      proto: 'udp' as const,
      port: 40000,
      status: 'open' as const,
    },
    {
      purpose: 'turn-relay' as const,
      proto: 'udp' as const,
      range: { begin: 40001, end: 40049 },
      status,
    },
  ];
  const merged = () => {
    const spec = coalesceTurnSpecs(portPlanOrFallback(undefined, 'relay')).find(
      (item) => item.purpose === 'turn-control'
    );
    if (!spec) throw new Error('合并后的 TURN 行不见了');
    return spec;
  };

  test('合并后的 TURN 行对不上任何一条探测，取控制口与中继段里更坏的那一条', () => {
    expect(merged().range).toEqual({ begin: 40000, end: 40049 });
    expect(reachForSpec(turnReach('blocked'), merged())).toBeUndefined();
    expect(reachForPlanSpec(turnReach('open'), merged())?.status).toBe('open');
    expect(reachForPlanSpec(turnReach('blocked'), merged())?.status).toBe('blocked');
    expect(reachForPlanSpec(turnReach('unknown'), merged())?.status).toBe('unknown');
  });

  test('只探到一段时就用那一段；两段都没有则为空', () => {
    const onlyControl = [turnReach('open')[0]];
    expect(reachForPlanSpec(onlyControl, merged())?.status).toBe('open');
    expect(reachForPlanSpec([], merged())).toBeUndefined();
  });

  test('没合并过的行照旧按 purpose+端口精确匹配', () => {
    const spec = { purpose: 'peer-signaling' as const, proto: 'tcp' as const, port: 39001 };
    const ports = [
      {
        purpose: 'peer-signaling' as const,
        proto: 'tcp' as const,
        port: 39001,
        status: 'open' as const,
      },
    ];
    expect(reachForPlanSpec(ports, spec)?.status).toBe('open');
    expect(reachForPlanSpec(ports, { ...spec, port: 39002 })).toBeUndefined();
  });
});
