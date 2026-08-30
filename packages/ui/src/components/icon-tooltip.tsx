import type { ReactNode } from 'react';
import { cn } from '../utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/** 顶栏图标按钮统一的悬停延迟：扫视时不会一路乱弹，停下来又不用等。 */
export const ICON_TOOLTIP_DELAY_MS = 400;

export interface IconTooltipProps {
  /** 同时用作按钮 aria-label 的短标题 */
  label: string;
  /** 顶栏一律 bottom，避免气泡压住标题行 */
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  children: ReactNode;
}

/**
 * 纯图标按钮的说明气泡。触发器渲染成 span 而不是按钮本身：禁用态的 <button>
 * 不再派发指针事件，套在外层才仍能悬停出提示；focusin 会冒泡到 span，
 * 键盘聚焦内部按钮同样能触发。
 */
export function IconTooltip({ label, side = 'bottom', className, children }: IconTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={ICON_TOOLTIP_DELAY_MS}
        className={cn('inline-flex shrink-0', className)}
        render={<span />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
