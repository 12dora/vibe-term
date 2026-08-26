import type { TextStreamPart, ToolSet } from 'ai';

export type AgentStreamPart = TextStreamPart<ToolSet>;

type HandledStreamPartType =
  | 'text-delta'
  | 'reasoning-delta'
  | 'tool-call'
  | 'tool-result'
  | 'tool-error'
  | 'tool-output-denied'
  | 'tool-approval-request'
  | 'error'
  | 'abort';

export type StreamPartHandlers = {
  [K in HandledStreamPartType]: (part: Extract<AgentStreamPart, { type: K }>) => void;
};

export function dispatchStreamPart(part: AgentStreamPart, handlers: StreamPartHandlers): void {
  const handler = handlers[part.type as HandledStreamPartType] as
    | ((p: AgentStreamPart) => void)
    | undefined;
  handler?.(part);
}

export interface StreamLoopWatchdog {
  start(): void;
  reset(): void;
  clear(): void;
}

export async function consumeAgentStream(
  stream: AsyncIterable<AgentStreamPart>,
  handlers: StreamPartHandlers,
  watchdog: StreamLoopWatchdog
): Promise<void> {
  try {
    watchdog.start();
    for await (const part of stream) {
      watchdog.reset();
      dispatchStreamPart(part, handlers);
    }
  } finally {
    watchdog.clear();
  }
}
