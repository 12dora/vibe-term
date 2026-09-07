// 离线成员防护：只有服务端那条带人数的 409 才换来二次确认，别的错误照旧直接报错。

import { describe, expect, test } from 'bun:test';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import { classifyGuardedWrite, relayMembersOffline } from './relay-offline-guard';

const offline = (details?: { online?: number; admitted?: number }) =>
  new RelayApiError('relay_members_offline', 'relay_members_offline', 409, details);

describe('relayMembersOffline', () => {
  test('认出 409 并带出在线 / 已准入人数', () => {
    expect(relayMembersOffline(offline({ online: 1, admitted: 4 }))).toEqual({
      online: 1,
      admitted: 4,
    });
  });

  test('一个都不在线也照样是这条防护（0 不能当缺失）', () => {
    expect(relayMembersOffline(offline({ online: 0, admitted: 3 }))).toEqual({
      online: 0,
      admitted: 3,
    });
  });

  test('人数缺失时不放行二次确认：拿不到人数的框讲不清后果', () => {
    expect(relayMembersOffline(offline())).toBeNull();
    expect(relayMembersOffline(offline({ online: 2 }))).toBeNull();
  });

  test('其它错误与非本族异常一律不认', () => {
    expect(relayMembersOffline(new RelayApiError('relay_kick_failed', 'boom', 500))).toBeNull();
    expect(relayMembersOffline(new Error('relay_members_offline'))).toBeNull();
    expect(relayMembersOffline(null)).toBeNull();
  });
});

describe('classifyGuardedWrite', () => {
  test('成功即 done', () => {
    expect(classifyGuardedWrite({ ok: true })).toEqual({ kind: 'done' });
  });

  test('被防护拦下时进二次确认', () => {
    const error = offline({ online: 2, admitted: 5 });
    expect(classifyGuardedWrite({ ok: false, error })).toEqual({
      kind: 'guard',
      offline: { online: 2, admitted: 5 },
    });
  });

  test('其它失败原样带出异常，交给调用点报错', () => {
    const error = new Error('boom');
    expect(classifyGuardedWrite({ ok: false, error })).toEqual({ kind: 'failed', error });
  });
});
