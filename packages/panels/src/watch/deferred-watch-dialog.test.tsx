// 监视对话框懒加载边界：没打开过就不挂载、不发 import；chunk 到位后照常渲染真正的对话框。
//
// bun test 无 DOM，用 react-dom/server 静态渲染。真正的 WatchDialog 走 Base UI 的 portal，
// 服务端渲染不了，故用 mock.module 换成同名哑组件——这里要验的是边界本身，不是对话框内容。

import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('./watch-dialog', () => ({
  WatchDialog: ({
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
  ),
}));

const { DeferredWatchDialog, preloadWatchDialog } = await import('./deferred-watch-dialog');

function render(open: boolean): string {
  return renderToStaticMarkup(
    <DeferredWatchDialog open={open} onOpenChange={() => undefined} deviceId="dev-1" paneId="%1" />
  );
}

/** 让 React.lazy 内部那个 import() 落地 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('DeferredWatchDialog', () => {
  test('没打开过就什么都不渲染', () => {
    expect(render(false)).toBe('');
  });

  test('打开时 chunk 还没到就先渲染空，不抛错', () => {
    expect(render(true)).toBe('');
  });

  test('chunk 到位后渲染真正的对话框，props 原样透传', async () => {
    render(true);
    await preloadWatchDialog();
    await flush();

    const html = render(true);
    expect(html).toContain('data-testid="watch-dialog-stub"');
    expect(html).toContain('dev-1 %1');
  });

  test('preloadWatchDialog 拿到的就是真正的 WatchDialog 模块', async () => {
    const module = (await preloadWatchDialog()) as { WatchDialog: unknown };
    expect(typeof module.WatchDialog).toBe('function');
  });
});
