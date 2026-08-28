// 设置面板全量出口：消费方（fe 设置页/设备页）按 featureset 决定渲染哪些 tab。

export { DeviceEntryCard } from './device-entry-card';
export {
  FilesSettingsTab,
  type FileRootDeviceGroup,
  type FileRootDeviceOption,
  type FilesSettingsTabProps,
} from './files-tab';
export { LlmProvidersTab } from './llm-providers-tab';
export { SearchTab } from './search-tab';
export {
  SETTINGS_NAMESPACE_QUERY_KEYS,
  SettingsEventsInit,
  queryKeysForNamespace,
  subscribeSettingsInvalidation,
  type SettingsQueryKey,
} from './settings-events-init';
export { TelegramBotsTab } from './telegram-bots-tab';
export { TerminalSettingsTab } from './terminal-tab';
export { VersionTab } from './version-tab';
export { WebhooksTab } from './webhooks-tab';
export { WeixinAccountsTab } from './weixin-accounts-tab';
export { ShortcutButtonRow } from './ShortcutButtonRow';
export { TerminalSettingsSheet } from './terminal-settings-sheet';
export {
  TerminalShortcutsEditor,
  type TerminalShortcutsEditorProps,
} from './TerminalShortcutsEditor';
