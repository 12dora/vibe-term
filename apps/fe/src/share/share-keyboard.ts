// 分享页的手机虚拟键盘避让：与 MainInset 同一套策略（见 apps/fe/src/main.tsx），
// 区别只在于这里没有侧栏抽屉，避让永不需要临时停用。

import { useUIStore } from '@tmex/stores/react';
import { useKeyboardAvoidance } from '@tmex/terminal-ui/hooks/use-keyboard-avoidance';
import type { CSSProperties } from 'react';

/** 分享页没有 mobile sidebar sheet，避让不存在「暂时停用」的情形。 */
export const SHARE_KEYBOARD_AVOIDANCE_DISABLED = false;

export function useShareKeyboardStyle(disabled: boolean): CSSProperties | undefined {
  const mode = useUIStore((state) => state.keyboardBehaviorMode);
  const avoidance = useKeyboardAvoidance(disabled, mode);

  if (avoidance.strategy === 'transform') {
    return {
      transform: `translateY(-${avoidance.offset}px)`,
      transition: mode === 'follow' ? undefined : 'transform 0.12s ease-out',
    };
  }
  if (avoidance.strategy === 'height') {
    return { height: `${avoidance.height}px`, transition: 'height 0.12s ease-out' };
  }
  return undefined;
}
