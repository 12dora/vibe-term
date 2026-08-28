import { describe, expect, test } from 'bun:test';

import { canRebindToRoute, shouldRedraftForRoute } from './agent-route-sync';

describe('canRebindToRoute', () => {
  const session = { deviceId: 'd1', paneId: '%1' };

  test('allows rebinding to another pane on the same device', () => {
    expect(canRebindToRoute(session, { deviceId: 'd1', paneId: '%2' })).toBe(true);
  });

  test('refuses a route pane on another device', () => {
    expect(canRebindToRoute(session, { deviceId: 'd2', paneId: '%2' })).toBe(false);
  });

  test('refuses when the route already matches the session pane', () => {
    expect(canRebindToRoute(session, { deviceId: 'd1', paneId: '%1' })).toBe(false);
  });

  test('refuses without a session or an incomplete route', () => {
    expect(canRebindToRoute(undefined, { deviceId: 'd1', paneId: '%2' })).toBe(false);
    expect(
      canRebindToRoute({ deviceId: null, paneId: null }, { deviceId: 'd1', paneId: '%2' })
    ).toBe(false);
    expect(canRebindToRoute(session, { deviceId: 'd1', paneId: null })).toBe(false);
    expect(canRebindToRoute(session, { deviceId: null, paneId: '%2' })).toBe(false);
  });
});

describe('shouldRedraftForRoute', () => {
  const draft = { deviceId: 'd1', paneId: '%1' };

  test('redrafts when the route pane changed', () => {
    expect(shouldRedraftForRoute(draft, { deviceId: 'd1', paneId: '%2' }, false)).toBe(true);
  });

  test('redrafts when the route device changed', () => {
    expect(shouldRedraftForRoute(draft, { deviceId: 'd2', paneId: '%1' }, false)).toBe(true);
  });

  test('keeps the draft while it matches the route', () => {
    expect(shouldRedraftForRoute(draft, { deviceId: 'd1', paneId: '%1' }, false)).toBe(false);
  });

  test('keeps the draft when the route has no pane', () => {
    expect(shouldRedraftForRoute(draft, { deviceId: 'd1', paneId: null }, false)).toBe(false);
    expect(shouldRedraftForRoute(draft, { deviceId: null, paneId: null }, false)).toBe(false);
  });

  test('does nothing without a draft or with an active session', () => {
    expect(shouldRedraftForRoute(null, { deviceId: 'd1', paneId: '%2' }, false)).toBe(false);
    expect(shouldRedraftForRoute(draft, { deviceId: 'd1', paneId: '%2' }, true)).toBe(false);
  });
});
