// 终端快捷键栏契约

/** 终端快捷键的特殊动作（非发送字符序列，而是触发前端行为）。 */
export type TerminalShortcutAction =
  | 'paste'
  | 'toggleKeyboard'
  | 'newAgentSession'
  | 'scrollToBottom';

/** 终端快捷键栏的单个按钮。 */
export interface TerminalShortcutItem {
  /** 稳定 id（拖拽排序 / React key）；自定义项用 crypto.randomUUID 生成 */
  id: string;
  /** send=向终端发送 payload；action=触发前端特殊动作 */
  type: 'send' | 'action';
  /** 显示文字（可编辑）；action 项为空时前端回退到内置 i18n 名 */
  label: string;
  /** type==='send' 时：发送到终端的原始控制序列 */
  payload?: string;
  /** type==='action' 时：要触发的动作 */
  action?: TerminalShortcutAction;
}

/** 终端快捷键设置（服务器单例，多端共享）。 */
export interface TerminalShortcutSettings {
  items: TerminalShortcutItem[];
  /** 是否用苹果风格符号替代 send 类按键的文字 */
  useIcons: boolean;
  updatedAt: string;
}

/** 更新终端快捷键设置请求体。 */
export interface UpdateTerminalShortcutSettingsRequest {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

/** 全部合法的特殊动作（服务端校验 + 前端枚举用）。 */
export const TERMINAL_SHORTCUT_ACTIONS: readonly TerminalShortcutAction[] = [
  'paste',
  'toggleKeyboard',
  'newAgentSession',
  'scrollToBottom',
];

/**
 * 默认快捷键列表（migration 直接写入单例行）。
 * payload 沿用历史终端栏取值；SHIFT-TAB 用 reverse-tab CSI Z。
 */
export const DEFAULT_TERMINAL_SHORTCUTS: TerminalShortcutItem[] = [
  { id: 'paste', type: 'action', action: 'paste', label: '' },
  { id: 'enter', type: 'send', label: 'Enter', payload: '\r' },
  { id: 'shift-tab', type: 'send', label: 'SHIFT-TAB', payload: '\x1b[Z' },
  { id: 'esc', type: 'send', label: 'ESC', payload: '\x1b' },
  { id: 'ctrl-c', type: 'send', label: 'CTRL-C', payload: '\x03' },
  { id: 'ctrl-d', type: 'send', label: 'CTRL-D', payload: '\x04' },
  { id: 'arrow-up', type: 'send', label: '↑', payload: '\x1b[A' },
  { id: 'arrow-down', type: 'send', label: '↓', payload: '\x1b[B' },
  { id: 'arrow-left', type: 'send', label: '←', payload: '\x1b[D' },
  { id: 'arrow-right', type: 'send', label: '→', payload: '\x1b[C' },
  { id: 'shift-enter', type: 'send', label: 'SHIFT-Enter', payload: '\x1b[13;2u' },
  { id: 'backspace', type: 'send', label: 'Backspace', payload: '\x08' },
];
