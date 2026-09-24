import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZE_BREAKER_BASE_MS,
  AUTHORIZE_BREAKER_MAX_MS,
  DIRECT_UNAVAILABLE_COOLDOWN_MS,
  authorizeBreakerShouldTry,
  authorizeProbeSuppressed,
  forceAuthorizeProbe,
  noteAuthorizeFailure,
  noteAuthorizeSuccess,
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
});
