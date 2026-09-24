import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZE_BREAKER_BASE_MS,
  AUTHORIZE_BREAKER_MAX_MS,
  DIRECT_UNAVAILABLE_COOLDOWN_MS,
  authorizeBreakerShouldTry,
  authorizeProbeSuppressed,
  beginAuthorizeAttempt,
  clearDirectUnavailable,
  forceAuthorizeProbe,
  noteAuthorizeFailure,
  noteAuthorizeSuccess,
  noteDirectBusy,
  noteDirectUnavailable,
  resetAuthorizeBreakerForTest,
  resetDirectAuthorizeBreakers,
} from './direct-authorize-breaker';

describe('direct authorize breaker', () => {
  test('trips after 3 failures at 30 s and caps at 5 min', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-a';
    let now = 1_000;
    expect(noteAuthorizeFailure(node, now).opened).toBe(false);
    expect(noteAuthorizeFailure(node, now).opened).toBe(false);
    const opened = noteAuthorizeFailure(node, now);
    expect(opened.opened).toBe(true);
    expect(opened.until).toBe(now + AUTHORIZE_BREAKER_BASE_MS);
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(false);

    now += AUTHORIZE_BREAKER_BASE_MS;
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(true);
    const second = noteAuthorizeFailure(node, now);
    expect(second.until).toBe(now + AUTHORIZE_BREAKER_BASE_MS * 2);

    now += AUTHORIZE_BREAKER_BASE_MS * 2;
    noteAuthorizeFailure(node, now);
    now += AUTHORIZE_BREAKER_BASE_MS * 4;
    const late = noteAuthorizeFailure(node, now);
    expect((late.until ?? 0) - now).toBeLessThanOrEqual(AUTHORIZE_BREAKER_MAX_MS);
    expect((late.until ?? 0) - now).toBeGreaterThanOrEqual(AUTHORIZE_BREAKER_BASE_MS);
  });

  test('success resets; forceProbe allows one try while cooling', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-b';
    const now = 5_000;
    noteAuthorizeFailure(node, now);
    noteAuthorizeFailure(node, now);
    noteAuthorizeFailure(node, now);
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(false);
    forceAuthorizeProbe(node);
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(true);
    noteAuthorizeSuccess(node);
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(true);
  });

  test('breaker open → login generation changes → authorize allowed', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-c';
    const now = 9_000;
    noteAuthorizeFailure(node, now);
    noteAuthorizeFailure(node, now);
    noteAuthorizeFailure(node, now);
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(false);
    resetDirectAuthorizeBreakers();
    expect(authorizeBreakerShouldTry(node, now).allow).toBe(true);
  });

  test('DIRECT_UNAVAILABLE 整段冷却 10 分钟：强制探测不放行，到期自动解除', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-d';
    const now = 1_000;
    expect(noteDirectUnavailable(node, now)).toBe(now + DIRECT_UNAVAILABLE_COOLDOWN_MS);
    const blocked = authorizeBreakerShouldTry(node, now + 1);
    expect(blocked.allow).toBe(false);
    expect(blocked.until).toBe(now + DIRECT_UNAVAILABLE_COOLDOWN_MS);
    forceAuthorizeProbe(node);
    expect(authorizeBreakerShouldTry(node, now + 1).allow).toBe(false);
    expect(authorizeProbeSuppressed(node, now + 1)).toBe(true);
    const later = now + DIRECT_UNAVAILABLE_COOLDOWN_MS;
    expect(authorizeBreakerShouldTry(node, later).allow).toBe(true);
    expect(authorizeProbeSuppressed(node, later)).toBe(false);
  });

  test('DIRECT_UNAVAILABLE 冷却随成功 / 登录世代变化清掉', () => {
    resetAuthorizeBreakerForTest();
    noteDirectUnavailable('node-e', 0);
    noteAuthorizeSuccess('node-e');
    expect(authorizeBreakerShouldTry('node-e', 1).allow).toBe(true);
    noteDirectUnavailable('node-e', 0);
    resetDirectAuthorizeBreakers();
    expect(authorizeBreakerShouldTry('node-e', 1).allow).toBe(true);
  });

  test('只有链路类失败压制「顺手再试」：NODE_UNREACHABLE 压，其余 5xx 不压', () => {
    resetAuthorizeBreakerForTest();
    noteAuthorizeFailure('node-f', 0, 'node-unreachable');
    expect(authorizeProbeSuppressed('node-f', 1)).toBe(true);
    noteAuthorizeFailure('node-f', 0);
    expect(authorizeProbeSuppressed('node-f', 1)).toBe(false);
    noteAuthorizeSuccess('node-f');
    expect(authorizeProbeSuppressed('node-f', 1)).toBe(false);
  });

  test('DIRECT_UNAVAILABLE 停放只能被显式清掉', () => {
    resetAuthorizeBreakerForTest();
    noteDirectUnavailable('node-g', 0);
    expect(authorizeBreakerShouldTry('node-g', 1).allow).toBe(false);
    clearDirectUnavailable('node-g');
    expect(authorizeBreakerShouldTry('node-g', 1).allow).toBe(true);
    expect(authorizeProbeSuppressed('node-g', 1)).toBe(false);
  });

  test('DIRECT_BUSY 计入熔断，retryAfterMs 是强制探测也越不过的最短间隔', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-h';
    const until = noteDirectBusy(node, 1_000, 5_000);
    expect(until).toBe(6_000);
    forceAuthorizeProbe(node);
    const held = authorizeBreakerShouldTry(node, 2_000);
    expect(held.allow).toBe(false);
    expect(held.until).toBe(6_000);
    expect(authorizeProbeSuppressed(node, 2_000)).toBe(false);
    expect(authorizeBreakerShouldTry(node, 6_000).allow).toBe(true);
    beginAuthorizeAttempt(node);

    noteDirectBusy(node, 6_000, null);
    noteDirectBusy(node, 6_000, null);
    const tripped = authorizeBreakerShouldTry(node, 6_001);
    expect(tripped.allow).toBe(false);
    expect(tripped.until).toBe(6_000 + AUTHORIZE_BREAKER_BASE_MS);
  });

  test('retryAfterMs 与熔断冷却取较晚者；成功清掉最短间隔', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-i';
    noteDirectBusy(node, 0, null);
    noteDirectBusy(node, 0, null);
    noteDirectBusy(node, 0, 60_000);
    expect(authorizeBreakerShouldTry(node, 1).until).toBe(60_000);
    noteAuthorizeSuccess(node);
    expect(authorizeBreakerShouldTry(node, 1).allow).toBe(true);
  });

  test('retryAfterMs 夸张时封顶到熔断上限', () => {
    resetAuthorizeBreakerForTest();
    expect(noteDirectBusy('node-j', 0, 24 * 3600_000)).toBe(AUTHORIZE_BREAKER_MAX_MS);
  });

  test('强制探测只放行一次：attempt 开始即消耗', () => {
    resetAuthorizeBreakerForTest();
    const node = 'node-k';
    for (let i = 0; i < 3; i += 1) noteAuthorizeFailure(node, 0);
    forceAuthorizeProbe(node);
    expect(authorizeBreakerShouldTry(node, 1).allow).toBe(true);
    beginAuthorizeAttempt(node);
    expect(authorizeBreakerShouldTry(node, 1).allow).toBe(false);
  });
});
