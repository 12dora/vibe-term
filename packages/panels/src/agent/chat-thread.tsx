import type { UiThreadBlock } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ArrowDownIcon } from 'lucide-react';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
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

type Decide = (confirmationId: string, approved: boolean) => void;

export interface ChatThreadProps {
  blocks: UiThreadBlock[];
  running: boolean;
  emptyText: string;
  confirmationByToolCallId: Map<string, string>;
  onDecide: Decide;
  className?: string;
}

export function isPinnedToBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
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
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  const decide = useCallback<Decide>(
    (confirmationId, approved) => decideRef.current(confirmationId, approved),
    []
  );
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);

  const scrollToBottom = (): void => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
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
      const el = containerRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
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
    if (el && anchor !== null) el.scrollTop = el.scrollHeight - anchor;
  }, [windowSize]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const pinned = isPinnedToBottom(el);
    pinnedRef.current = pinned;
    setShowJumpToBottom(!pinned);
  };

  const showEarlier = (): void => {
    const el = containerRef.current;
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setWindowSize((size) => size + WINDOW_STEP);
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

  const hidden = Math.max(0, blocks.length - windowSize);

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
          {threadRows(hidden > 0 ? blocks.slice(hidden) : blocks, confirmationByToolCallId, decide)}
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
