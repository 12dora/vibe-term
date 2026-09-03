import { describe, expect, test } from 'bun:test';
import {
  browserVisibility,
  buildDirectDiagnostics,
  quantizedRtt,
  sameDiagnosticsForPublish,
  sameDirectDiagnostics,
} from './direct-diagnostics';
import { type DirectDiagnostics, PRIMARY_ONLY_DIAGNOSTICS } from './types';

describe('browserVisibility', () => {
  test('无 document 时按可见处理，subscribe 为 no-op', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'document');
    try {
      const visibility = browserVisibility();
      expect(visibility.hidden()).toBe(false);
      let fired = 0;
      const unsubscribe = visibility.subscribe(() => {
        fired += 1;
      });
      unsubscribe();
      expect(fired).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
    }
  });

  test('有 document 时跟随 visibilityState，visibilitychange 时回调', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const listeners = new Set<() => void>();
    const stub = {
      visibilityState: 'visible',
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') listeners.delete(listener);
      },
    };
    Object.defineProperty(globalThis, 'document', { value: stub, configurable: true });
    try {
      const visibility = browserVisibility();
      expect(visibility.hidden()).toBe(false);
      let fired = 0;
      const unsubscribe = visibility.subscribe(() => {
        fired += 1;
      });
      expect(listeners.size).toBe(1);
      stub.visibilityState = 'hidden';
      expect(visibility.hidden()).toBe(true);
      for (const listener of listeners) listener();
      expect(fired).toBe(1);
      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});

describe('sameDirectDiagnostics', () => {
  test('RTT 在 5 ms 桶内抖动视为未变；路径或 ICE 态变化则不同', () => {
    const ice = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      selectedPair: 'host → host',
    };
    const a: DirectDiagnostics = {
      ...PRIMARY_ONLY_DIAGNOSTICS,
      path: 'direct',
      route: 'lan',
      rtt: 4,
      ice,
    };
    expect(sameDirectDiagnostics(a, { ...a, rtt: 6.4 })).toBe(true);
    expect(sameDirectDiagnostics(a, { ...a, rtt: 12 })).toBe(false);
    expect(sameDirectDiagnostics(a, { ...a, path: 'primary' })).toBe(false);
    expect(sameDiagnosticsForPublish(a, { ...a, rtt: 6.4 })).toBe(true);
    expect(
      sameDirectDiagnostics(a, {
        ...a,
        ice: { ...ice, connectionState: 'connecting' },
      })
    ).toBe(false);
  });

  test('buildDirectDiagnostics 只在 active 暴露 route/rtt，connecting 仍带 ice', () => {
    const ice = {
      connectionState: 'connecting',
      iceConnectionState: 'checking',
      localCandidateType: null,
      remoteCandidateType: null,
      selectedPair: null,
    };
    const breaker = {
      cooling: false,
      until: null,
      failures: 0,
      level: 0,
      lastFailureKind: null,
    };
    const idle = buildDirectDiagnostics('idle', { route: 'lan', rtt: 12, ice, breaker });
    expect(idle.path).toBe('primary');
    expect(idle.route).toBeNull();
    expect(idle.ice).toBeNull();
    expect(
      buildDirectDiagnostics('connecting', { route: 'lan', rtt: 12, ice, breaker }).ice
    ).toEqual(ice);
    const active = buildDirectDiagnostics('active', { route: 'lan', rtt: 12, ice, breaker });
    expect(active.path).toBe('direct');
    expect(active.route).toBe('lan');
    expect(active.rtt).toBe(12);
  });

  test('quantizedRtt 把 null 与非有限值收成 null', () => {
    expect(quantizedRtt(null)).toBeNull();
    expect(quantizedRtt(Number.NaN)).toBeNull();
    expect(quantizedRtt(4)).toBe(5);
    expect(quantizedRtt(12)).toBe(10);
  });
});
