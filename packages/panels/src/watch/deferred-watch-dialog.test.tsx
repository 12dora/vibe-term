// 监视对话框懒加载边界：没打开过就不挂载、不发 import；chunk 到位后照常渲染真正的对话框；
// chunk 拉不下来（发版后旧 hash 404）时给兜底条而不是把整条路由炸掉。
//
// bun test 无 DOM，用 react-dom/server 静态渲染。真正的 WatchDialog 走 Base UI 的 portal，
// 服务端渲染不了，故经 `setWatchDialogImporterForTests` 换成同名哑组件——这里要验的是边界
// 本身，不是对话框内容。

import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeferredWatchDialog,
  loadWatchDialog,
  preloadWatchDialog,
  schedulePreloadWatchDialog,
  setWatchDialogImporterForTests,
  watchDialogFallbackView,
} from './deferred-watch-dialog';

const WatchDialogStub = ({
  open,
  deviceId,
  paneId,
}: {
  open: boolean;
  deviceId: string;
  paneId: string;
}) => (
  <div data-testid="watch-dialog-stub" data-open={open}>
    {`${deviceId} ${paneId}`}
  </div>
);

function useStubImporter(): void {
  setWatchDialogImporterForTests(async () => ({ WatchDialog: WatchDialogStub }));
}

function render(open: boolean): string {
  return renderToStaticMarkup(
    <DeferredWatchDialog open={open} onOpenChange={() => undefined} deviceId="dev-1" paneId="%1" />
  );
}

afterEach(() => {
  setWatchDialogImporterForTests(null);
});

describe('DeferredWatchDialog', () => {
  test('没打开过就什么都不渲染', () => {
    useStubImporter();
    expect(render(false)).toBe('');
  });

  test('打开时 chunk 还没到就先渲染空，不抛错', () => {
    useStubImporter();
    expect(render(true)).toBe('');
  });

  test('chunk 到位后渲染真正的对话框，props 原样透传', async () => {
    useStubImporter();
    await preloadWatchDialog();

    const html = render(true);
    expect(html).toContain('data-testid="watch-dialog-stub"');
    expect(html).toContain('dev-1 %1');
  });
});

describe('loadWatchDialog', () => {
  test('成功后复用同一份组件，不重复 import', async () => {
    let calls = 0;
    setWatchDialogImporterForTests(async () => {
      calls += 1;
      return { WatchDialog: WatchDialogStub };
    });
    const first = await loadWatchDialog();
    const second = await loadWatchDialog();
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  test('失败不缓存：下一次请求会重新发起 import（React.lazy 做不到这点）', async () => {
    let calls = 0;
    setWatchDialogImporterForTests(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk 404');
      return { WatchDialog: WatchDialogStub };
    });

    await expect(loadWatchDialog()).rejects.toThrow('chunk 404');
    expect(await loadWatchDialog()).toBe(WatchDialogStub);
    expect(calls).toBe(2);
  });

  test('并发请求只发一次 import', async () => {
    let calls = 0;
    setWatchDialogImporterForTests(async () => {
      calls += 1;
      return { WatchDialog: WatchDialogStub };
    });
    const [a, b] = await Promise.all([loadWatchDialog(), loadWatchDialog()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});

describe('watchDialogFallbackView', () => {
  test('没失败过不显示任何兜底条', () => {
    expect(watchDialogFallbackView(0)).toBeNull();
  });

  test('第一次失败就给重试 + 整页刷新', () => {
    const view = watchDialogFallbackView(1);
    expect(view?.role).toBe('alert');
    expect(view?.messageKey).toBe('watch.rules.loadFailed');
    expect(view?.hintKey).toBe('settings.terminal.loadFailedHint');
    expect(view?.showRetry).toBe(true);
    expect(view?.showReload).toBe(true);
  });

  test('就地重试到上限后只留整页刷新', () => {
    const view = watchDialogFallbackView(2);
    expect(view?.showRetry).toBe(false);
    expect(view?.showReload).toBe(true);
  });
});

describe('schedulePreloadWatchDialog', () => {
  test('功能关掉时一次空闲调度都不排', () => {
    let scheduled = 0;
    const cancel = schedulePreloadWatchDialog(false, () => {
      scheduled += 1;
      return () => undefined;
    });
    cancel();
    expect(scheduled).toBe(0);
  });

  test('功能开着才预热，且取消函数原样透传', () => {
    useStubImporter();
    let cancelled = 0;
    let run: (() => void) | null = null;
    const cancel = schedulePreloadWatchDialog(true, (task) => {
      run = task;
      return () => {
        cancelled += 1;
      };
    });
    expect(typeof run).toBe('function');
    cancel();
    expect(cancelled).toBe(1);
  });
});
