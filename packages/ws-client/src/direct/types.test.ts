import { describe, expect, test } from 'bun:test';
import {
  PRIMARY_ONLY_DIAGNOSTICS,
  createDeferredDiagnosticsSource,
  resolveDirectDiagnostics,
} from './types';
import type { DirectDiagnostics, DirectDiagnosticsSource } from './types';

function fakeSource(): DirectDiagnosticsSource & { snapshot: DirectDiagnostics; emit(): void } {
  const listeners = new Set<() => void>();
  const source = {
    snapshot: { ...PRIMARY_ONLY_DIAGNOSTICS, path: 'direct' as const },
    get: () => source.snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  return source;
}

describe('createDeferredDiagnosticsSource', () => {
  test('接上真实来源前恒为 primary 快照，引用稳定', () => {
    const deferred = createDeferredDiagnosticsSource();
    expect(deferred.get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
    expect(deferred.get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
  });

  test('attach 后转发快照，并唤醒加载期间就挂上的订阅者', () => {
    const deferred = createDeferredDiagnosticsSource();
    let notified = 0;
    const unsubscribe = deferred.subscribe(() => {
      notified += 1;
    });

    const inner = fakeSource();
    deferred.attach(inner);
    expect(notified).toBe(1);
    expect(deferred.get()).toBe(inner.snapshot);

    inner.snapshot = { ...inner.snapshot, rtt: 12 };
    inner.emit();
    expect(notified).toBe(2);
    expect(deferred.get()).toBe(inner.snapshot);

    unsubscribe();
    inner.emit();
    expect(notified).toBe(2);
  });

  test('attach(null) 摘掉来源并退订，回到 primary', () => {
    const deferred = createDeferredDiagnosticsSource();
    const inner = fakeSource();
    deferred.attach(inner);

    let notified = 0;
    deferred.subscribe(() => {
      notified += 1;
    });
    deferred.attach(null);

    expect(notified).toBe(1);
    expect(deferred.get()).toBe(PRIMARY_ONLY_DIAGNOSTICS);
    inner.emit();
    expect(notified).toBe(1);
  });

  test('挂到 connection 上后 resolveDirectDiagnostics 取到的就是它', () => {
    const deferred = createDeferredDiagnosticsSource();
    expect(resolveDirectDiagnostics({ directDiagnostics: deferred })).toBe(deferred);
  });
});
