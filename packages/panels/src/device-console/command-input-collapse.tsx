// 命令输入框（editor 输入模式面板）的展开/收起动画：
// 顶栏图标切模式时，面板不再是「凭空出现、凭空消失」。
// 用 grid-template-rows 0fr↔1fr 做高度过渡（内容高度不用写死），
// 叠一点透明度与位移；收起先播完动画再卸载，故本组件自己管挂载。

import { cn } from '@tmex/ui';
import { type ReactNode, useEffect, useState } from 'react';

/** 与 --tmex-motion-layout 对齐：动画跑完才卸载面板 */
export const COMMAND_INPUT_COLLAPSE_MS = 200;

export type CollapseDataState = 'open' | 'closed';

export interface CollapsePresence {
  /** 是否留在 DOM 里（收起动画期间仍为 true） */
  mounted: boolean;
  /** 展开态：驱动 data-state 与过渡终值 */
  expanded: boolean;
}

export function collapseDataState(expanded: boolean): CollapseDataState {
  return expanded ? 'open' : 'closed';
}

/**
 * 展开先挂载、下一帧才置展开态——起止值同帧写入浏览器不会过渡；
 * 收起先置收起态，等 durationMs 后卸载。首屏就是展开态时不播入场动画。
 */
export function useCollapsePresence(
  open: boolean,
  durationMs: number = COMMAND_INPUT_COLLAPSE_MS
): CollapsePresence {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [open, durationMs]);

  return { mounted, expanded };
}

export interface CommandInputCollapseProps {
  open: boolean;
  children: ReactNode;
}

export function CommandInputCollapse({ open, children }: CommandInputCollapseProps) {
  const { mounted, expanded } = useCollapsePresence(open);
  if (!mounted) {
    return null;
  }
  return (
    <div
      data-testid="command-input-collapse"
      data-state={collapseDataState(expanded)}
      className={cn(
        // Tailwind v4 的 translate-* 写的是 translate 属性而不是 transform，过渡要点名它
        'grid grid-rows-[1fr] transition-[grid-template-rows,opacity,translate]',
        'duration-(--tmex-motion-layout) ease-out motion-reduce:transition-none',
        'data-[state=closed]:grid-rows-[0fr] data-[state=closed]:translate-y-1',
        'data-[state=closed]:opacity-0 data-[state=closed]:ease-in'
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
