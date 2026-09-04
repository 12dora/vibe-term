import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { isStandaloneDisplay, shouldOpenSidebarOnLaunch } from '@/lib/standalone';
import { useUIStore } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';

// 以 PWA 启动（iOS 添加到主屏）时首页直接展开侧边栏抽屉，落在「终端」分节，
// 而不是设备页。判定只看**本次加载落地的路径**：从 `/settings` 冷启动后再导航到 `/`
// 不会补弹抽屉。每次加载只触发一次：用户关掉抽屉后不再自动弹回。
// 挂在 RootLayout 内部，`/login` 不在这棵路由下，登录页不会触发；登录后跳回 `/` 时
// RootLayout 重新挂载，effect 照常执行。
//
// 用 `openMobileWithoutFocus()` 而不是 `setOpenMobile(true)`：抽屉是我们替用户打开的，
// 焦点不该跟着走到「关闭侧边栏」上（冷启动后左上角挂着一圈焦点环）。用户自己开的抽屉照旧。
export function StandaloneLanding() {
  const { isMobile, openMobileWithoutFocus } = useSidebar();
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
    openMobileWithoutFocus();
  }, [isMobile, openMobileWithoutFocus, setSidebarTab]);

  return null;
}
