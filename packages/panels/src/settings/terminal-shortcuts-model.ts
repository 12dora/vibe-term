import type { TerminalShortcutAction, TerminalShortcutItem } from '@tmex/shared';
import { ArrowDownToLine, ClipboardPaste, Keyboard, type LucideIcon, Radar } from 'lucide-react';

export const ACTION_META: { action: TerminalShortcutAction; icon: LucideIcon }[] = [
  { action: 'paste', icon: ClipboardPaste },
  { action: 'toggleKeyboard', icon: Keyboard },
  { action: 'newAgentSession', icon: Radar },
  { action: 'scrollToBottom', icon: ArrowDownToLine },
];

export function actionIcon(action: TerminalShortcutAction): LucideIcon {
  return ACTION_META.find((m) => m.action === action)?.icon ?? Radar;
}

export function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// 按固定字段顺序归一化后比较，规避对象键顺序差异（服务端规范化 vs 前端构造）造成的假阳性。
function normItem(i: TerminalShortcutItem): string {
  return JSON.stringify([i.id, i.type, i.label, i.payload ?? null, i.action ?? null]);
}

export function sameItems(a: TerminalShortcutItem[], b: TerminalShortcutItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((it, idx) => normItem(it) === normItem(b[idx]));
}

export function createSendItem(label: string, payload: string): TerminalShortcutItem {
  return { id: genId(), type: 'send', label: label || payload, payload };
}

export function createActionItem(action: TerminalShortcutAction): TerminalShortcutItem {
  return { id: genId(), type: 'action', action, label: '' };
}
