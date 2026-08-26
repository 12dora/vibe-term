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
