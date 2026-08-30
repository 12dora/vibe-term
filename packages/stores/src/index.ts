// 应用状态层：runtime 工厂、每 node 运行时管理器与纯函数工具。
// 默认 runtime 与其原名 store 导出移到 `@tmex/stores/default-runtime`（见该文件注释）。

export { createAppRuntime, type AppRuntime } from './app-runtime';
export {
  DEFAULT_RELEASE_GRACE_MS,
  NodeConnectionManager,
  SELF_NODE_ID,
  createDefaultNodeConnection,
  nodeRuntimes,
  nodeStoragePrefix,
  normalizeNodeId,
  useNodeRuntime,
  type NodeConnectionManagerOptions,
  type NodeRuntimeEntry,
} from './node-connection-manager';
export {
  createBrowserHostServices,
  hostAppPath,
  type AppRuntimeOptions,
  type BrowserHostOptions,
  type HostServices,
  type RuntimeCore,
  type SaveFileInput,
  type TerminalFileLinkRoot,
  type TerminalFileLinksProvider,
  type RuntimeFeatures,
} from './runtime';

export { createUIStore, type KeyboardBehaviorMode, type SidebarTab, type UIStore } from './ui';
export {
  isSidebarDeviceVisible,
  isSidebarFilesVisible,
  sidebarDeviceVisibilityKey,
} from './sidebar-device-visibility';
export { createSiteStore, type SiteStore } from './site';
export { createTmuxStore, type DeviceInitialErrorInput, type TmuxStore } from './tmux';
export {
  createAgentStore,
  type AgentStore,
  type CreateSessionOptions,
  type DraftSession,
  type AgentState,
  type PendingConfirmationUi,
  type StartDraftInput,
} from './agent';
export { resolveAgentStore, setAgentHostStore } from './agent-host-store';
export { isSessionOnNode, normalizeAgentNodeId, type SessionMap } from './agent-session-map';
export { createFileTreeStore, fileNodeKey, type FileTreeStore } from './file-tree';

export * from './agent-thread';
export {
  getSiteNameFallback,
  getSiteUrlFallback,
  setSiteFallbackReader,
  type SiteFallbackSnapshot,
} from './site-fallback';
export { decodePaneIdFromUrlParam, encodePaneIdForUrl } from './tmux-url';
export { decodeFileRef, encodeFileRef, fileRoute, type FileRef } from './file-url';
export * from './terminal-meta';
export {
  USER_INITIATED_SELECTION_EVENT,
  dispatchUserInitiatedSelection,
  navigateToAppUrl,
  toAppPath,
  type UserInitiatedSelectionDetail,
} from './app-navigation';
export {
  bridgeCloseMobileSidebar,
  bridgeIsMobile,
  bridgeNavigate,
  bridgeOpenMobileSidebar,
  resetFlowBridgesForTest,
  setNavigateBridge,
  setSidebarBridge,
} from './flow-bridges';
export { selectPaneAgentState, type PaneAgentState } from './use-pane-agent-state';

export type { AgentSessionDto, AgentSessionStatus } from '@tmex/shared';
