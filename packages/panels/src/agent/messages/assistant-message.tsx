import { cn } from '@tmex/ui';
import { memo } from 'react';
import { StreamingMarkdown } from '../../markdown/streaming-markdown';

export const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div
      data-testid="agent-assistant-message"
      className={cn('min-w-0 max-w-full self-start', className)}
    >
      <StreamingMarkdown text={text} streaming={streaming} />
    </div>
  );
});
