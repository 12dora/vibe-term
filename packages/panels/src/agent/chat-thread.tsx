import type { UiThreadBlock } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ArrowDownIcon } from 'lucide-react';
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { AssistantMessage } from './messages/assistant-message';
import { ReasoningBlock } from './messages/reasoning-block';
import { ToolCallCard } from './messages/tool-call-card';
import { UserMessage } from './messages/user-message';

const PIN_THRESHOLD_PX = 48;
/** 默认只渲染最近这么多块，点「显示更早」再按此步长展开 */
const WINDOW_STEP = 200;
/** 超过这么多块才给行加 content-visibility：短会话全在视口里，跳渲判定纯属多余 */
export const CHAT_ROW_SKIP_RENDER_THRESHOLD = 40;
/** 视口外的块只留占位高度；`auto` 会记住真实渲染过的高度，滚回去不会跳 */
const SKIPPED_ROW_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 64px',
};

type Decide = (confirmationId: string, approved: boolean) => void;

export interface ChatThreadProps {
  blocks: UiThreadBlock[];
  running: boolean;
  emptyText: string;
  confirmationByToolCallId: Map<string, string>;
  onDecide: Decide;
  className?: string;
}

/**
 * 渲染窗口的起点：吸底时跟着最新的 windowSize 条走；
 * 用户上滚（frozenStart 非空）后起点冻结，新块只往下追加，正在读的块不会被顶掉。
 */
export function windowStartIndex(
  total: number,
  windowSize: number,
  frozenStart: number | null
): number {
  if (frozenStart !== null) return Math.min(frozenStart, Math.max(0, total - 1));
  return Math.max(0, total - windowSize);
}

export function isPinnedToBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
}

interface ScrollBox {
  scrollHeight: number;
  scrollTop: number;
}

/** 吸底：内容长高多少就往下补多少。 */
export function stickToBottom(el: ScrollBox): void {
  el.scrollTop = el.scrollHeight;
}

/** 「距底距离」锚点：展开更早的消息会让 scrollHeight 变大，靠它把视口钉回原来那一段。 */
export function bottomAnchor(el: ScrollBox): number {
  return el.scrollHeight - el.scrollTop;
}

export function restoreBottomAnchor(el: ScrollBox, anchor: number): void {
  el.scrollTop = el.scrollHeight - anchor;
}

export interface FrameHost {
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

const DEFAULT_FRAME_HOST: FrameHost = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
};

/**
 * 滚动事件合帧：一帧内来多少次 scroll 都只测量一次。
 * 惯性滚动一帧能打十几个事件，每个都同步读 scrollHeight/scrollTop/clientHeight
 * 就是十几次强制布局。
 */
export interface ScrollCoalescer {
  onScroll: () => void;
  /** 立刻结算还压在这一帧里的那次测量（吸底前必须先知道用户是不是刚上滚）。 */
  flush: () => void;
  dispose: () => void;
}

export function createScrollCoalescer(
  measure: () => void,
  host: FrameHost = DEFAULT_FRAME_HOST
): ScrollCoalescer {
  let frame: number | null = null;
  const cancel = (): boolean => {
    if (frame === null) return false;
    host.cancelAnimationFrame(frame);
    frame = null;
    return true;
  };
  return {
    onScroll: () => {
      if (frame !== null) return;
      frame = host.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    },
    flush: () => {
      if (cancel()) measure();
    },
    dispose: () => void cancel(),
  };
}

/**
 * 每个块渲染成一个 React.memo 行：key 取块 id，props 全是稳定引用或原始值，
 * 于是流式期间只有尾部的块换了对象、只有尾行重渲染。
 */
export function threadRows(
  blocks: UiThreadBlock[],
  confirmationByToolCallId: Map<string, string>,
  onDecide: Decide
): ReactElement[] {
  const rows: ReactElement[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'user':
        rows.push(<UserMessage key={block.key} text={block.text} />);
        break;
      case 'assistant-text':
        rows.push(
          <AssistantMessage key={block.key} text={block.text} streaming={block.streaming} />
        );
        break;
      case 'reasoning':
        rows.push(<ReasoningBlock key={block.key} text={block.text} streaming={block.streaming} />);
        break;
      case 'tool-call':
        rows.push(
          <ToolCallCard
            key={block.key}
            call={block.call}
            confirmationId={confirmationByToolCallId.get(block.call.toolCallId)}
            onDecide={onDecide}
          />
        );
        break;
      default:
        break;
    }
  }
  return rows;
}

function RunningIndicator() {
  return (
    <div data-testid="agent-running-indicator" className="flex items-center gap-1 self-start px-1">
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full" />
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full [animation-delay:150ms]" />
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full [animation-delay:300ms]" />
    </div>
  );
}

export function ChatThread({
  blocks,
  running,
  emptyText,
  confirmationByToolCallId,
  onDecide,
  className,
}: ChatThreadProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const coalescerRef = useRef<ScrollCoalescer | null>(null);
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  const decide = useCallback<Decide>(
    (confirmationId, approved) => decideRef.current(confirmationId, approved),
    []
  );
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);
  const [frozenStart, setFrozenStart] = useState<number | null>(null);

  const scrollToBottom = (): void => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom(el);
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    setFrozenStart(null);
  };

  // 吸底：用户未上滚时新内容自动滚到底，多次 flush 合并成一帧一次读写，避免每次提交都强制布局
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks/running 变化即触发吸底
  useEffect(() => {
    if (!pinnedRef.current) {
      setShowJumpToBottom(true);
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // 同一帧里用户刚上滚过的话，先把那次测量结算掉，别把人拽回底部。
      coalescerRef.current?.flush();
      const el = containerRef.current;
      if (el && pinnedRef.current) stickToBottom(el);
    });
  }, [blocks, running]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  // 展开更早的消息后按「距底距离」锚点回写 scrollTop，视口内容不跳
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowSize 变化即是回写时机
  useLayoutEffect(() => {
    const el = containerRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (el && anchor !== null) restoreBottomAnchor(el, anchor);
  }, [windowSize, frozenStart]);

  // 测量函数每次渲染都换一份（要读到最新的 blocks/windowSize），
  // 但合帧器只建一次，用 ref 中转。
  const measureRef = useRef<() => void>(() => undefined);
  measureRef.current = () => {
    const el = containerRef.current;
    if (!el) return;
    const pinned = isPinnedToBottom(el);
    pinnedRef.current = pinned;
    setShowJumpToBottom(!pinned);
    setFrozenStart((prev) =>
      pinned ? null : (prev ?? windowStartIndex(blocks.length, windowSize, null))
    );
  };
  const scrollCoalescer = useMemo(() => createScrollCoalescer(() => measureRef.current()), []);
  coalescerRef.current = scrollCoalescer;
  useEffect(() => scrollCoalescer.dispose, [scrollCoalescer]);
  const handleScroll = scrollCoalescer.onScroll;

  const showEarlier = (): void => {
    const el = containerRef.current;
    anchorRef.current = el ? bottomAnchor(el) : null;
    if (frozenStart !== null) setFrozenStart(Math.max(0, frozenStart - WINDOW_STEP));
    else setWindowSize((size) => size + WINDOW_STEP);
  };

  if (blocks.length === 0 && !running) {
    return (
      <div
        data-testid="agent-chat-thread"
        className={cn('flex min-h-0 flex-1 items-center justify-center p-4', className)}
      >
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      </div>
    );
  }

  const hidden = windowStartIndex(blocks.length, windowSize, frozenStart);
  const rows = threadRows(
    hidden > 0 ? blocks.slice(hidden) : blocks,
    confirmationByToolCallId,
    decide
  );
  // 行外包一层 flex 列：块自己的 self-start / self-end 仍然生效，跳渲样式挂在这一层。
  const rowStyle = rows.length > CHAT_ROW_SKIP_RENDER_THRESHOLD ? SKIPPED_ROW_STYLE : undefined;

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={containerRef}
        data-testid="agent-chat-thread"
        className="h-full overflow-y-auto p-3"
        onScroll={handleScroll}
      >
        <div className="flex flex-col gap-3">
          {hidden > 0 && (
            <Button
              data-testid="agent-show-earlier"
              size="sm"
              variant="ghost"
              className="text-muted-foreground self-center text-xs"
              onClick={showEarlier}
            >
              {t('agent.panel.showEarlier', { count: hidden })}
            </Button>
          )}
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col" style={rowStyle}>
              {row}
            </div>
          ))}
          {running && <RunningIndicator />}
        </div>
      </div>

      {showJumpToBottom && (
        <Button
          data-testid="agent-scroll-to-bottom"
          size="icon-sm"
          variant="secondary"
          className="absolute right-3 bottom-3 z-10 rounded-full shadow-md"
          onClick={scrollToBottom}
          aria-label={t('agent.panel.scrollToBottom')}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
