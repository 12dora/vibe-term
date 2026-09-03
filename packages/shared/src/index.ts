// tmex 前后端共享类型定义（barrel）
//
// 本文件只做再导出：跨域契约按领域拆分在 ./contracts/* 下，
// 运行时模块（i18n / ws-borsh / appearance / tmux-layout / capabilities）在各自目录。
//
// 注意：环境变量加载器 loadEnv 是 Node-only（依赖 node:fs/node:url），
// 不能从本浏览器侧主入口导出——否则会被打进客户端 bundle 触发
// "Module node:fs has been externalized" 运行时错误。
// Node 侧消费者请直接 import './env/load-env'（相对路径）。

// ==================== i18n ====================

// Types
export type { LocaleInfo, Manifest, TranslationKey } from './i18n/types';
export type { LocaleCode } from './i18n/resources';

// Runtime values (generated from manifest)
export {
  I18N_RESOURCES,
  I18N_MANIFEST,
  DEFAULT_LOCALE,
  AVAILABLE_LOCALES as SUPPORTED_LOCALES,
  toBCP47,
} from './i18n/resources';

// ==================== Version ====================

export { formatDisplayVersion } from './version';
export {
  type Semver,
  compareSemver,
  compareSemverRequired,
  parseSemver,
  requireSemver,
} from './semver';

// ==================== 品牌 ====================

export { BRAND_LOGO_SRC, PRODUCT_NAME } from './brand';

// ==================== 通用工具 ====================

export {
  type NormalizePosixPathOptions,
  basename,
  dirname,
  normalizePosixPath,
} from './posix-path';
export {
  DEFERRED_CLIPBOARD_TTL_MS,
  type DeferredClipboardHandlers,
  type DeferredClipboardOptions,
  type DeferredClipboardWriter,
  type GestureEventTarget,
  createDeferredClipboardWriter,
  writeTextToClipboard,
} from './browser-clipboard';

// ==================== 日期格式化 ====================

export { type DateInput, formatDate, formatDateTime } from './format-date';

// ==================== 领域契约 ====================

export * from './contracts/system';
export * from './contracts/devices';
export * from './contracts/site-settings';
export * from './contracts/terminal-shortcuts';
export * from './contracts/telegram';
export * from './contracts/weixin';
export * from './contracts/tmux';
export * from './contracts/websocket';
export * from './contracts/notifications';
export * from './contracts/tunnel';
export * from './contracts/llm';
export * from './contracts/agent';
export * from './contracts/watch';
export * from './contracts/files';
export * from './contracts/device-folders';
export * from './contracts/local-auth';
export * from './contracts/hub-role';
export * from './device-folders';

// ==================== 运行时模块再导出 ====================

export { b } from './ws-borsh';
export * as wsBorsh from './ws-borsh';

export {
  EMPTY_PANE_MODE_FLAGS,
  PANE_MODE_ALT_SCREEN,
  PANE_MODE_FLAGS_PRESENT,
  type PaneModeFlags,
  decodePaneModes,
  encodePaneModes,
} from './ws-borsh/pane-modes';

export {
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  type TerminalThemeColors,
  type TerminalThemeName,
  getOsc11ResponseColor,
  getTerminalTheme,
  getTmuxWindowStyle,
} from './appearance';

export {
  collectLayoutLeaves,
  layoutLeafPaneId,
  parseWindowLayout,
  type ParsedWindowLayout,
  type TmuxLayoutLeaf,
  type TmuxLayoutNode,
  type TmuxLayoutSplit,
} from './tmux-layout';

// Agent/Watch WS 事件 payload 类型（JSON 形状约定，前后端共用）
export type {
  AgentSessionWireStatus,
  AgentConfirmationWireStatus,
  AgentPendingConfirmation,
  AgentQueuedMessageWire,
  AgentQueueUpdatedPayload,
  AgentSyncEventPayload,
  AgentStatusEventPayload,
  AgentTextDeltaPayload,
  AgentReasoningDeltaPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentConfirmationRequestPayload,
  AgentConfirmationResolvedPayload,
  AgentMessagePersistedPayload,
  AgentErrorEventPayload,
  AgentTurnFinishedPayload,
  AgentCredentialWarningPayload,
  WatchTriggeredPayload,
  WatchModelUnavailablePayload,
  WatchRuleErrorPayload,
  AgentEventPayloadMap,
  WatchEventPayloadMap,
  AgentEventType,
  WatchEventType,
} from './ws-borsh/agent';

export {
  API_VERSION,
  GATEWAY_CAPABILITIES,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1,
} from './capabilities';

export * from './network';
export * from './tmux-version';

// ==================== 角色模型 ====================

export {
  type TmexRoleName,
  type TmexRoles,
  isStandaloneRoles,
  isTmexRoleName,
  roleNameFromFlags,
  rolesFromName,
} from './roles';
export * from './release/source';
