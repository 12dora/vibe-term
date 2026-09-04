import * as React from 'react';

export type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  /** 替用户自动弹出移动端抽屉：这一次不移动焦点（PWA 冷启动落在首页时用）。 */
  openMobileWithoutFocus: () => void;
  /** 移动端抽屉的 `initialFocus`：`false` = 这次打开不移动焦点，`undefined` = Base UI 默认。 */
  mobileInitialFocus: false | undefined;
  isMobile: boolean;
  toggleSidebar: () => void;
  isResizing: boolean;
  setIsResizing: (resizing: boolean) => void;
};

/**
 * 宽度单独一份 context：拖拽把宽度一帧一改，留在主 context 里会让每个 `useSidebar()`
 * 消费者（每一行菜单按钮、每个文件叶子、每个 pane 行）跟着每帧重渲染。
 * 真正读宽度的只有 resizer 自己。
 */
export type SidebarWidthContextProps = {
  width: number;
  /** 只改内存宽度（拖拽途中每帧调用），不落盘 */
  setWidth: (width: number) => void;
  /** 把当前宽度写进 localStorage（拖拽结束时调用一次） */
  commitWidth: () => void;
  resetWidth: () => void;
};

export const SidebarWidthContext = React.createContext<SidebarWidthContextProps | null>(null);

export function useSidebarWidth() {
  const context = React.useContext(SidebarWidthContext);
  if (!context) {
    throw new Error('useSidebarWidth must be used within a SidebarProvider.');
  }

  return context;
}

export const SidebarContext = React.createContext<SidebarContextProps | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}
