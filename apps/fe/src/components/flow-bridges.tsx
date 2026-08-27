import { setNavigateBridge, setSidebarBridge } from '@tmex/stores';
import { useSidebar } from '@tmex/ui/sidebar';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

// 注册 navigate / sidebar 桥接。必须挂在 RouterProvider + SidebarProvider 内（如 RootLayout）。
// 注册返回自身的注销函数：node 切换时新旧边界短暂并存也不会互相抹掉。
export function FlowBridges() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => setNavigateBridge((to, opts) => navigate(to, opts ?? {})), [navigate]);

  useEffect(() => setSidebarBridge({ isMobile, setOpenMobile }), [isMobile, setOpenMobile]);

  return null;
}
