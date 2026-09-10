// 移动端侧栏抽屉在真实 SidebarProvider（matchMedia 判定视口）下的接线：收起时侧栏子树
// 仍然渲染。抽屉一卸载，SidebarTitle 的站点设置、每个节点的运行时与 /api/devices
// 就要在下次打开时全部重来，用户看到的就是「一点终端列表，整个侧栏都在转」。
// 真实 SheetContent 渲染在 base-ui 的 portal 里，静态渲染取不到标记，换成记账探针。

import { describe, expect, mock, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { ReactNode } from 'react';

installWindowStorage();

// SidebarProvider 建 state 时就读 matchMedia；`matches` 即「桌面端」。
let desktopViewport = false;
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: desktopViewport,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const sheetProps: Record<string, unknown>[] = [];

const realSheet = (await import('@vibeterm/ui/sheet')) as unknown as Record<string, unknown>;
mock.module('@vibeterm/ui/sheet', () => ({
  ...realSheet,
  SheetContent: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    sheetProps.push(props);
    return <div data-testid="sheet-content-probe">{children}</div>;
  },
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { Sidebar, SidebarProvider } = await import('@vibeterm/ui/sidebar');

function render(desktop: boolean): string {
  desktopViewport = desktop;
  sheetProps.length = 0;
  return renderToStaticMarkup(
    <SidebarProvider>
      <Sidebar>
        <div data-testid="sidebar-subtree">终端列表</div>
      </Sidebar>
    </SidebarProvider>
  );
}

describe('移动端抽屉的挂载边界', () => {
  test('抽屉收起时侧栏子树照常挂着', () => {
    const html = render(false);

    expect(html).toContain('data-testid="sidebar-subtree"');
    expect(sheetProps).toHaveLength(1);
    expect(sheetProps[0]?.keepMounted).toBe(true);
    expect(sheetProps[0]?.inert).toBe(true);
  });

  test('桌面端不经 Sheet，行为不变', () => {
    const html = render(true);

    expect(html).toContain('data-testid="sidebar-subtree"');
    expect(sheetProps).toHaveLength(0);
  });
});
