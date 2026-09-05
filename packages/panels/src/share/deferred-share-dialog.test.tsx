import { afterEach, describe, expect, test } from 'bun:test';
import {
  schedulePreloadShareDialog,
  setShareDialogImporterForTests,
  shareDialogFallbackView,
} from './deferred-share-dialog';

afterEach(() => setShareDialogImporterForTests(null));

describe('shareDialogFallbackView', () => {
  test('没失败过就不出兜底条', () => {
    expect(shareDialogFallbackView(0)).toBeNull();
  });

  test('首次失败给重试 + 重新加载', () => {
    const view = shareDialogFallbackView(1);
    expect(view?.messageKey).toBe('share.dialog.loadFailed');
    expect(view?.showRetry).toBe(true);
    expect(view?.showReload).toBe(true);
  });

  test('重试用尽后只留重新加载', () => {
    const view = shareDialogFallbackView(2);
    expect(view?.showRetry).toBe(false);
    expect(view?.showReload).toBe(true);
  });
});

describe('schedulePreloadShareDialog', () => {
  test('关掉时一次调度都不排', () => {
    let scheduled = 0;
    schedulePreloadShareDialog(false, () => {
      scheduled += 1;
      return () => undefined;
    });
    expect(scheduled).toBe(0);
  });

  test('开着时排一次空闲预热，返回取消函数', () => {
    let cancelled = false;
    let run: (() => void) | null = null;
    setShareDialogImporterForTests(() => Promise.resolve({ ShareDialog: (() => null) as never }));

    const cancel = schedulePreloadShareDialog(true, (task) => {
      run = task;
      return () => {
        cancelled = true;
      };
    });

    expect(run).not.toBeNull();
    (run as unknown as () => void)();
    cancel();
    expect(cancelled).toBe(true);
  });
});
