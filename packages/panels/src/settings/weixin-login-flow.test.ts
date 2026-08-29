import { describe, expect, test } from 'bun:test';
import type { WeixinAccountUser, WeixinLoginStatus, WeixinLoginStatusResponse } from '@tmex/shared';

import {
  WEIXIN_LOGIN_POLL_INTERVAL_MS,
  type WeixinLoginClassification,
  buildUserBaseline,
  classifyWeixinLoginStatus,
  findFreshUser,
  weixinLoginEndpoints,
} from './weixin-login-flow';

function user(overrides: Partial<WeixinAccountUser> & { userId: string }): WeixinAccountUser {
  return {
    id: `row-${overrides.userId}`,
    accountId: 'acc-1',
    displayName: overrides.userId,
    status: 'authorized',
    needsReactivation: false,
    lastInboundAt: null,
    appliedAt: '2026-01-01T00:00:00.000Z',
    authorizedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function statusResponse(
  status: WeixinLoginStatus,
  loggedIn: boolean,
  message?: string
): WeixinLoginStatusResponse {
  return message === undefined ? { status, loggedIn } : { status, loggedIn, message };
}

describe('WEIXIN_LOGIN_POLL_INTERVAL_MS', () => {
  test('轮询间隔固定为 1500ms', () => {
    expect(WEIXIN_LOGIN_POLL_INTERVAL_MS).toBe(1500);
  });
});

describe('classifyWeixinLoginStatus', () => {
  const cases: {
    name: string;
    response: WeixinLoginStatusResponse;
    expected: WeixinLoginClassification;
  }[] = [
    {
      name: 'expired 优先于 loggedIn',
      response: statusResponse('expired', true),
      expected: { kind: 'expired' },
    },
    {
      name: 'error 带 message',
      response: statusResponse('error', false, 'boom'),
      expected: { kind: 'error', message: 'boom' },
    },
    {
      name: 'error 缺 message 时退化为空串',
      response: statusResponse('error', false),
      expected: { kind: 'error', message: '' },
    },
    {
      name: 'error 优先于 loggedIn',
      response: statusResponse('error', true, 'boom'),
      expected: { kind: 'error', message: 'boom' },
    },
    {
      name: 'status=confirmed 视为确认',
      response: statusResponse('confirmed', false),
      expected: { kind: 'confirmed' },
    },
    {
      name: 'loggedIn 视为确认',
      response: statusResponse('pending', true),
      expected: { kind: 'confirmed' },
    },
    {
      name: 'pending 且未登录时继续等待',
      response: statusResponse('pending', false),
      expected: { kind: 'pending' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(classifyWeixinLoginStatus(c.response)).toEqual(c.expected);
    });
  }
});

describe('buildUserBaseline', () => {
  test('按 userId 记录 lastInboundAt（含 null）', () => {
    const baseline = buildUserBaseline([
      user({ userId: 'a', lastInboundAt: '2026-01-02T00:00:00.000Z' }),
      user({ userId: 'b', lastInboundAt: null }),
    ]);
    expect(baseline.size).toBe(2);
    expect(baseline.get('a')).toBe('2026-01-02T00:00:00.000Z');
    expect(baseline.get('b')).toBeNull();
    expect(baseline.has('b')).toBe(true);
  });

  test('空列表得到空基线', () => {
    expect(buildUserBaseline([]).size).toBe(0);
  });

  test('重复 userId 以最后一条为准', () => {
    const baseline = buildUserBaseline([
      user({ userId: 'a', lastInboundAt: 'old' }),
      user({ userId: 'a', lastInboundAt: 'new' }),
    ]);
    expect(baseline.size).toBe(1);
    expect(baseline.get('a')).toBe('new');
  });
});

describe('findFreshUser', () => {
  const baseline = buildUserBaseline([
    user({ userId: 'a', lastInboundAt: 'T1' }),
    user({ userId: 'b', lastInboundAt: null }),
  ]);

  test('基线内且 lastInboundAt 未变时无新消息', () => {
    const fresh = findFreshUser(
      [user({ userId: 'a', lastInboundAt: 'T1' }), user({ userId: 'b', lastInboundAt: null })],
      baseline
    );
    expect(fresh).toBeUndefined();
  });

  test('新用户（不在基线内）算新消息', () => {
    const fresh = findFreshUser(
      [user({ userId: 'a', lastInboundAt: 'T1' }), user({ userId: 'c', lastInboundAt: null })],
      baseline
    );
    expect(fresh?.userId).toBe('c');
  });

  test('lastInboundAt 变化算新消息', () => {
    const fresh = findFreshUser([user({ userId: 'a', lastInboundAt: 'T2' })], baseline);
    expect(fresh?.userId).toBe('a');
  });

  test('null → 有值算新消息', () => {
    const fresh = findFreshUser([user({ userId: 'b', lastInboundAt: 'T3' })], baseline);
    expect(fresh?.userId).toBe('b');
  });

  test('有值 → null 算新消息', () => {
    const fresh = findFreshUser([user({ userId: 'a', lastInboundAt: null })], baseline);
    expect(fresh?.userId).toBe('a');
  });

  test('多个候选时取列表中第一个', () => {
    const fresh = findFreshUser(
      [user({ userId: 'a', lastInboundAt: 'T1' }), user({ userId: 'c' }), user({ userId: 'd' })],
      baseline
    );
    expect(fresh?.userId).toBe('c');
  });

  test('空基线下任意用户都算新消息', () => {
    const fresh = findFreshUser([user({ userId: 'a', lastInboundAt: 'T1' })], new Map());
    expect(fresh?.userId).toBe('a');
  });

  test('空用户列表返回 undefined', () => {
    expect(findFreshUser([], baseline)).toBeUndefined();
  });

  test('保留 pending 状态供调用方决定是否 approve', () => {
    const fresh = findFreshUser([user({ userId: 'c', status: 'pending' })], baseline);
    expect(fresh?.status).toBe('pending');
  });
});

describe('weixinLoginEndpoints', () => {
  const endpoints = weixinLoginEndpoints('acc-1');

  test('登录相关端点路径', () => {
    expect(endpoints.start).toBe('/api/settings/weixin/accounts/acc-1/login/start');
    expect(endpoints.status).toBe('/api/settings/weixin/accounts/acc-1/login/status');
    expect(endpoints.users).toBe('/api/settings/weixin/accounts/acc-1/users');
  });

  test('approve 路径对 userId 做 URL 编码', () => {
    expect(endpoints.approve('wx id/1')).toBe(
      '/api/settings/weixin/accounts/acc-1/users/wx%20id%2F1/approve'
    );
  });
});
