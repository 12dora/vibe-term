import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes-store';
import { setEntryNodeIdBridge, setNavigateBridge, setSidebarBridge } from '@vibeterm/stores';
import { useSidebar } from '@vibeterm/ui/sidebar';
import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';

// 注册 navigate / sidebar 桥接。必须挂在 RouterProvider + SidebarProvider 内（如 RootLayout）。
// 注册返回自身的注销函数：node 切换时新旧边界短暂并存也不会互相抹掉。
export function FlowBridges() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => setNavigateBridge((to, opts) => navigate(to, opts ?? {})), [navigate]);

  useEffect(() => setSidebarBridge({ isMobile, setOpenMobile }), [isMobile, setOpenMobile]);

  // 通知深链 /n/<入口id>/... 的选择事件要折叠成 self，与 useRouteNodeId 同口径。
  const entryNodeId = useSyncExternalStore(
    subscribeMeshNodes,
    () => getMeshNodesState().entryNodeId,
    () => getMeshNodesState().entryNodeId
  );
  useEffect(() => {
    setEntryNodeIdBridge(entryNodeId);
    return () => setEntryNodeIdBridge(null);
  }, [entryNodeId]);

  return null;
}
