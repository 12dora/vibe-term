import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZE_BREAKER_BASE_MS,
  AUTHORIZE_BREAKER_MAX_MS,
  authorizeBreakerShouldTry,
  forceAuthorizeProbe,
  noteAuthorizeFailure,
  noteAuthorizeSuccess,
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
});
