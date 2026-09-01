import { describe, expect, it } from 'bun:test';
import { resolvePaneSizeSyncPlan } from './pane-size-sync-plan';

const base = {
  now: 1_000_000,
  isSplitView: false,
  canInteractWithPane: true,
  isLoading: false,
  remotePane: { width: 100, height: 40 },
  currentSize: { cols: 80, rows: 24 },
  pendingLocalSize: null,
  ttlMs: 2000,
  hasPaneRoute: true,
};

describe('resolvePaneSizeSyncPlan', () => {
  it('分屏不回灌', () => {
    expect(resolvePaneSizeSyncPlan({ ...base, isSplitView: true })).toEqual({ kind: 'skip' });
  });

  it('不可交互 / 加载中 / 无远端 pane 都跳过', () => {
    expect(resolvePaneSizeSyncPlan({ ...base, canInteractWithPane: false }).kind).toBe('skip');
    expect(resolvePaneSizeSyncPlan({ ...base, isLoading: true }).kind).toBe('skip');
    expect(resolvePaneSizeSyncPlan({ ...base, remotePane: null }).kind).toBe('skip');
    expect(resolvePaneSizeSyncPlan({ ...base, currentSize: null }).kind).toBe('skip');
  });

  it('尺寸不同则 resize 并重建 history', () => {
    expect(resolvePaneSizeSyncPlan(base)).toEqual({
      kind: 'apply',
      cols: 100,
      rows: 40,
      clearPendingLocalSize: false,
      resize: true,
      rebuildHistory: true,
    });
  });

  it('尺寸一致时不 resize，也不重建 history', () => {
    const plan = resolvePaneSizeSyncPlan({ ...base, currentSize: { cols: 100, rows: 40 } });
    expect(plan).toMatchObject({ kind: 'apply', resize: false, rebuildHistory: false });
  });

  it('路由不完整（无 deviceId/paneId）时仍 resize，但不重建 history', () => {
    const plan = resolvePaneSizeSyncPlan({ ...base, hasPaneRoute: false });
    expect(plan).toMatchObject({ kind: 'apply', resize: true, rebuildHistory: false });
  });

  it('本地 resize 在途未确认时让位并安排重试', () => {
    const plan = resolvePaneSizeSyncPlan({
      ...base,
      pendingLocalSize: { cols: 120, rows: 50, at: base.now - 500 },
    });
    expect(plan.kind).toBe('retry');
    if (plan.kind === 'retry') expect(plan.delayMs).toBeGreaterThan(0);
  });

  it('在途本地尺寸与远端一致时清 pending', () => {
    const plan = resolvePaneSizeSyncPlan({
      ...base,
      pendingLocalSize: { cols: 100, rows: 40, at: base.now - 500 },
    });
    expect(plan).toMatchObject({ kind: 'apply', clearPendingLocalSize: true });
  });
});
