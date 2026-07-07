// 应用状态层：zustand stores、路由/站点 helper、模块级导航桥

export {
  useAgentStore,
  type CreateSessionOptions,
  type DraftSession,
  type PendingConfirmationUi,
} from './agent';
export * from './agent-thread';
export { fileNodeKey, useFileTreeStore } from './file-tree';
export { useSiteStore } from './site';
export { useTmuxStore, type DeviceInitialErrorInput } from './tmux';
export { useUIStore, type KeyboardBehaviorMode, type SidebarTab } from './ui';
export { usePaneAgentState, type PaneAgentState } from './use-pane-agent-state';
export { getSiteNameFallback, getSiteUrlFallback } from './site-fallback';
export { decodePaneIdFromUrlParam, encodePaneIdForUrl } from './tmux-url';
export { decodeFileRef, encodeFileRef, fileRoute, type FileRef } from './file-url';
export * from './terminal-meta';
export { navigateToAppUrl } from './app-navigation';
export {
  bridgeCloseMobileSidebar,
  bridgeIsMobile,
  bridgeNavigate,
  bridgeOpenMobileSidebar,
  setNavigateBridge,
  setSidebarBridge,
} from './flow-bridges';
