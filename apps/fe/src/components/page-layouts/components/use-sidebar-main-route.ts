// 侧栏与主区路由的联动：记住最近的主区路由（供「收起文件管理器」回去），
// 以及用户切到「文件」tab 时把主区带到文件管理器。
// 入口 chunk 依赖：只用 stores 的路由小模块，不碰文件管理器工作区。

import { EXPLORER_ROUTE, type SidebarTab } from '@vibeterm/stores';
import { rememberMainRoute, shouldShowExplorerOnTabChange } from '@vibeterm/stores/main-route';
import { useUIStore } from '@vibeterm/stores/react';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * 返回侧栏 tab 的变更处理器：先落 tab，再按需把主区带去文件管理器。只响应用户切换，
 * 初始渲染 / 持久化恢复不触发；用 navigate 而不收抽屉——手机上用户正在抽屉里浏览文件树。
 * 同时随路由记下最近的主区路由；挂在常驻的侧栏外壳上，手机抽屉关着时也在记。
 */
export function useSidebarMainRoute(): (tab: SidebarTab) => void {
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  useEffect(() => {
    rememberMainRoute({ pathname, search: location.search, hash: location.hash });
  }, [pathname, location.search, location.hash]);
  return (tab) => {
    setSidebarTab(tab);
    if (shouldShowExplorerOnTabChange(tab, pathname)) navigate(EXPLORER_ROUTE);
  };
}
