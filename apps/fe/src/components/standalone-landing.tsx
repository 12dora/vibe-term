import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import {
  isStandaloneDisplay,
  releaseFocusInsideSheet,
  shouldOpenSidebarOnLaunch,
} from '@/lib/standalone';
import { useUIStore } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';

/**
 * 抽屉是我们替用户打开的，焦点不该跟着走。Base UI 在打开后的下一帧把焦点移到抽屉里的第一个
 * 可聚焦元素，所以这里盯住这一次移动：焦点一落进抽屉就收回来，两帧之内没动就撤掉监听，
 * 免得把用户自己点出来的焦点也收走。
 */
export function suppressAutoOpenFocus(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  let frame = 0;
  function stop() {
    document.removeEventListener('focusin', onFocusIn);
    cancelAnimationFrame(frame);
  }
  function onFocusIn(event: FocusEvent) {
    if (releaseFocusInsideSheet(event.target)) stop();
  }
  document.addEventListener('focusin', onFocusIn);
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(stop);
  });
  return stop;
}

// 以 PWA 启动（iOS 添加到主屏）时首页直接展开侧边栏抽屉，落在「终端」分节，
// 而不是设备页。判定只看**本次加载落地的路径**：从 `/settings` 冷启动后再导航到 `/`
// 不会补弹抽屉。每次加载只触发一次：用户关掉抽屉后不再自动弹回。
// 挂在 RootLayout 内部，`/login` 不在这棵路由下，登录页不会触发；登录后跳回 `/` 时
// RootLayout 重新挂载，effect 照常执行。
export function StandaloneLanding() {
  const { isMobile, setOpenMobile } = useSidebar();
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  const { pathname } = useLocation();
  const launchPathnameRef = useRef(pathname);
  const firedRef = useRef(false);

  // `isMobile` 可能晚一帧才为真，所以仍然要跟着它重跑；`pathname` 刻意不在依赖里。
  useEffect(() => {
    const shouldOpen = shouldOpenSidebarOnLaunch({
      isMobile,
      standalone: isStandaloneDisplay(),
      launchPathname: launchPathnameRef.current,
      alreadyFired: firedRef.current,
    });
    if (!shouldOpen) return;
    firedRef.current = true;
    setSidebarTab('panes');
    setOpenMobile(true);
    return suppressAutoOpenFocus();
  }, [isMobile, setOpenMobile, setSidebarTab]);

  return null;
}
