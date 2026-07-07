// 通知模块：文案组装、bell 状态与声音（i18n 经 t 注入）

export {
  buildPaneLocationLabel,
  formatTerminalNotificationToast,
  type TranslateFn,
} from './notification-format';
export { playBellSound } from './bell-sound';
export { useBellStore } from './bell-store';
