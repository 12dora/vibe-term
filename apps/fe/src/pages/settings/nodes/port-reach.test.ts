import { describe, expect, test } from 'bun:test';
import {
  asPortRole,
  blockedPortReaches,
  formatPortReach,
  parsePortPlan,
  parsePortReachList,
  portPlanFromStatus,
  portPlanOrFallback,
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
  });
});
