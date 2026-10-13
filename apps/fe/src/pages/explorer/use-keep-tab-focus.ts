// 方向键在标签页之间移动时守住标签页上的焦点。
// 新激活的标签页主体挂载后会把焦点拿去给文件列表（鼠标点标签页时这正是想要的），
// 但键盘用户还要接着按方向键。做法：方向键激活时登记一下，之后焦点一旦落进主体就还给那个标签页；
// 用户做了别的事（任何指针按下、方向键以外的按键）登记即作废。

import { type FocusEvent, type KeyboardEvent, type RefObject, useCallback, useRef } from 'react';

/** 这次按键是不是「继续在标签页之间移动」 */
export function keepsTabFocus(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight';
}

function findTabElement(pane: HTMLElement | null, tabId: string): HTMLElement | null {
  const tabs = Array.from(pane?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []);
  return tabs.find((tab) => tab.dataset.tabId === tabId) ?? null;
}

export interface KeepTabFocus {
  /** 标签栏：方向键激活了这个标签页 */
  onKeyboardActivate(tabId: string): void;
  /** 挂在分栏根上（capture）：用户换了操作方式，放手 */
  onPointerDownCapture(): void;
  onKeyDownCapture(event: KeyboardEvent<HTMLElement>): void;
  /** 挂在主体容器上（capture）：焦点被主体拿走时还回去 */
  onBodyFocusCapture(event: FocusEvent<HTMLElement>): void;
}

export function useKeepTabFocus(
  paneRef: RefObject<HTMLElement | null>,
  activeTabId: string | null
): KeepTabFocus {
  const pending = useRef<string | null>(null);
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;

  const onKeyboardActivate = useCallback((tabId: string) => {
    pending.current = tabId;
  }, []);

  const onPointerDownCapture = useCallback(() => {
    pending.current = null;
  }, []);

  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!keepsTabFocus(event.key)) pending.current = null;
  }, []);

  const onBodyFocusCapture = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const tabId = pending.current;
      if (tabId === null) return;
      // 活动标签页已经被别的途径换掉（关闭、弹簧加载），这份登记不再作数
      if (tabId !== activeRef.current) {
        pending.current = null;
        return;
      }
      const tab = findTabElement(paneRef.current, tabId);
      if (!tab || tab === event.target) return;
      tab.focus({ preventScroll: true });
    },
    [paneRef]
  );

  return { onKeyboardActivate, onPointerDownCapture, onKeyDownCapture, onBodyFocusCapture };
}
