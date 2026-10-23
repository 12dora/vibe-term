// 预览页方向键切换的判定：纯函数，不碰 DOM 事件对象的具体类型，便于无 DOM 单测。

import type { FileCategory } from '@vibeterm/shared';
import { MEDIA_CATEGORIES } from './preview-categories';

export interface ArrowKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

// 焦点在这些元素上时方向键归它自己：输入框移动光标，媒体控件快进 / 调音量。
const OWN_ARROW_TAGS: ReadonlySet<string> = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'AUDIO',
  'VIDEO',
]);

function ownsArrowKeys(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const { tagName, isContentEditable } = target as {
    tagName?: string;
    isContentEditable?: boolean;
  };
  if (isContentEditable) return true;
  return typeof tagName === 'string' && OWN_ARROW_TAGS.has(tagName.toUpperCase());
}

/** 该按键是否要切换预览；返回切换方向，不处理返回 null。 */
export function arrowKeyDirection(
  event: ArrowKeyEvent,
  category: FileCategory
): 'prev' | 'next' | null {
  if (!MEDIA_CATEGORIES.has(category) || event.defaultPrevented) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  if (ownsArrowKeys(event.target)) return null;
  return event.key === 'ArrowLeft' ? 'prev' : 'next';
}
