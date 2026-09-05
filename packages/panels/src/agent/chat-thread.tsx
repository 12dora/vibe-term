import type { UiThreadBlock } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ArrowDownIcon } from 'lucide-react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { type Decide, ThreadRows, threadRows } from './chat-thread-rows';
import { useChatScroll } from './use-chat-scroll';

export { CHAT_ROW_SKIP_RENDER_THRESHOLD, threadRows } from './chat-thread-rows';
export {
  type FrameHost,
  type ScrollCoalescer,
  bottomAnchor,
  createScrollCoalescer,
  isPinnedToBottom,
  restoreBottomAnchor,
  stickToBottom,
  windowStartIndex,
} from './use-chat-scroll';

export interface ChatThreadProps {
  blocks: UiThreadBlock[];
  running: boolean;
  emptyText: string;
  confirmationByToolCallId: Map<string, string>;
  onDecide: Decide;
  className?: string;
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
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  const decide = useCallback<Decide>(
    (confirmationId, approved) => decideRef.current(confirmationId, approved),
    []
  );
  const { containerRef, hidden, showJumpToBottom, onScroll, scrollToBottom, showEarlier } =
    useChatScroll(blocks, running);

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

  const rows = threadRows(
    hidden > 0 ? blocks.slice(hidden) : blocks,
    confirmationByToolCallId,
    decide
  );

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={containerRef}
        data-testid="agent-chat-thread"
        className="h-full overflow-y-auto p-3"
        onScroll={onScroll}
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
          <ThreadRows rows={rows} />
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
