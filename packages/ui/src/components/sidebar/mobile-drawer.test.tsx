// 移动端抽屉：收起时侧栏子树必须**留在 DOM 里**。卸载重挂等于把设备取数、节点运行时协商、
// 骨架屏全部重来一遍（用户看到的「一点终端列表全在转」）。
// 真实的 SheetContent 渲染在 base-ui 的 portal 里，静态渲染取不到标记，
// 所以把它换成一个记账探针：既能读到透下去的 keepMounted / inert，也能看见子树本身。

import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { SidebarContextProps, SidebarWidthContextProps } from './context';

const sheetProps: Record<string, unknown>[] = [];

const realSheet = (await import('../sheet')) as unknown as Record<string, unknown>;
mock.module('../sheet', () => ({
  ...realSheet,
  SheetContent: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    sheetProps.push(props);
    return <div data-testid="sheet-content-probe">{children}</div>;
  },
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { SidebarContext, SidebarWidthContext } = await import('./context');
const { Sidebar } = await import('./sidebar-layout');

const WIDTH: SidebarWidthContextProps = {
  width: 256,
  setWidth: () => undefined,
  commitWidth: () => undefined,
  resetWidth: () => undefined,
};

function sidebarContext(openMobile: boolean): SidebarContextProps {
  return {
    state: 'expanded',
    open: true,
    setOpen: () => undefined,
    openMobile,
    setOpenMobile: () => undefined,
    openMobileWithoutFocus: () => undefined,
    mobileInitialFocus: undefined,
    isMobile: true,
    toggleSidebar: () => undefined,
    isResizing: false,
    setIsResizing: () => undefined,
  };
}

function renderMobileSidebar(openMobile: boolean): {
  html: string;
  props: Record<string, unknown>;
} {
  sheetProps.length = 0;
  const html = renderToStaticMarkup(
    <SidebarContext.Provider value={sidebarContext(openMobile)}>
      <Sidebar>
        <div data-testid="sidebar-subtree">终端列表</div>
      </Sidebar>
    </SidebarContext.Provider>
  );
  return { html, props: sheetProps[0] ?? {} };
}

describe('移动端侧栏抽屉', () => {
  test('收起时子树照常渲染，且要求 Sheet 保持挂载', () => {
    const { html, props } = renderMobileSidebar(false);

    expect(html).toContain('data-testid="sidebar-subtree"');
    expect(props.keepMounted).toBe(true);
  });

  test('收起时整棵树 inert：不抢终端的键盘焦点，也进不了 Tab 序列', () => {
    expect(renderMobileSidebar(false).props.inert).toBe(true);
  });

  test('展开时解除 inert', () => {
    const { html, props } = renderMobileSidebar(true);

    expect(props.inert).toBe(false);
    expect(html).toContain('data-testid="sidebar-subtree"');
  });

  test('桌面端不走 Sheet：侧栏本来就常驻', () => {
    sheetProps.length = 0;
    const html = renderToStaticMarkup(
      <SidebarContext.Provider value={{ ...sidebarContext(false), isMobile: false }}>
        <SidebarWidthContext.Provider value={WIDTH}>
          <Sidebar>
            <div data-testid="sidebar-subtree" />
          </Sidebar>
        </SidebarWidthContext.Provider>
      </SidebarContext.Provider>
    );

    expect(sheetProps).toHaveLength(0);
    expect(html).toContain('data-slot="sidebar-inner"');
  });
});
