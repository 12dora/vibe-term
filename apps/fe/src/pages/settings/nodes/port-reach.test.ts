import { describe, expect, test } from 'bun:test';
import { formatPortList } from '@vibeterm/shared/net';
import {
  asPortRole,
  blockedPortReaches,
  formatPortReach,
  localPortsTitleKey,
  parsePortPlan,
  parsePortReachList,
  portPlanFromStatus,
  portPlanOrFallback,
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
    expect(reachForSpec(ports, { purpose: 'peer-signaling', port: 39001 })?.status).toBe('open');
    expect(reachForSpec(ports, { purpose: 'peer-signaling', port: 39002 })).toBeUndefined();
    expect(reachForSpec(ports, { purpose: 'public-https', port: 443 })).toBeUndefined();
    expect(reachForSpec(undefined, { purpose: 'peer-signaling', port: 39001 })).toBeUndefined();
  });

  test('range 对上才算 rtc-ice', () => {
    expect(
      reachForSpec(ports, { purpose: 'rtc-ice', range: { begin: 40000, end: 40099 } })?.status
    ).toBe('unknown');
    expect(
      reachForSpec(ports, { purpose: 'rtc-ice', range: { begin: 40050, end: 40099 } })
    ).toBeUndefined();
  });
});

describe('localPortsTitleKey', () => {
  test('含 relay 用中继标题，hub,node 用 Hub，其余用本机', () => {
    expect(localPortsTitleKey('relay')).toBe('localMachine.ports.titleRelay');
    expect(localPortsTitleKey('relay,node')).toBe('localMachine.ports.titleRelay');
    expect(localPortsTitleKey('hub,node')).toBe('localMachine.ports.titleHub');
    expect(localPortsTitleKey('node')).toBe('localMachine.ports.titleNode');
    expect(localPortsTitleKey('standalone')).toBe('localMachine.ports.titleNode');
    expect(localPortsTitleKey(null)).toBe('localMachine.ports.titleNode');
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
    expect(asPortRole('whatever', 'hub,node')).toBe('hub,node');
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
