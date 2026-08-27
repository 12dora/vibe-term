import type { TerminalShortcutAction } from '@tmex/shared';
import { ArrowDownToLine, ClipboardPaste, Keyboard, type LucideIcon, Radar } from 'lucide-react';

export const ACTION_META: { action: TerminalShortcutAction; icon: LucideIcon }[] = [
  { action: 'paste', icon: ClipboardPaste },
  { action: 'toggleKeyboard', icon: Keyboard },
  { action: 'newAgentSession', icon: Radar },
  { action: 'scrollToBottom', icon: ArrowDownToLine },
];

export function actionIcon(action: TerminalShortcutAction): LucideIcon {
  return ACTION_META.find((meta) => meta.action === action)?.icon ?? Radar;
}
