import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';

import { cn } from '../utils';

interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  /**
   * `vertical`：只允许纵向滚动，横向溢出直接裁掉。
   *
   * Base UI 的 Viewport 把 `overflow: scroll` 写进内联样式（class 赢不了它），所以只能用同一个
   * 简写属性覆盖；顺带断掉横向滚动链，拖拽时不会把整块内容拽偏。
   */
  axis?: 'both' | 'vertical';
}

const VERTICAL_ONLY_VIEWPORT_STYLE = {
  overflow: 'hidden scroll',
  overscrollBehaviorX: 'none',
} as const;

function ScrollArea({ className, children, axis = 'both', ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        style={axis === 'vertical' ? VERTICAL_ONLY_VIEWPORT_STYLE : undefined}
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {/* 不渲染 Corner：本仓从不挂横向 ScrollBar，两条滚动条的交点恒不存在，
          base-ui 的 Corner 在 `scrollbarXHidden || scrollbarYHidden` 时本就返回 null。 */}
      <ScrollBar />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        'data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent flex touch-none p-px transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none select-none',
        '[@media(any-pointer:coarse)]:hidden',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="rounded-full bg-border relative flex-1"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
export type { ScrollAreaProps };
