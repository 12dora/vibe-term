export interface ApprovalMessageLike {
  role: string;
  content: unknown;
}

export interface ApprovalRequest {
  type: string;
  approvalId: string;
  toolCallId: string;
}

export interface InspectedApprovals {
  requests: ApprovalRequest[];
  respondedApprovalIds: Set<string>;
  resolvedToolCallIds: Set<string>;
}

export type ApprovalConfirmationStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export interface ApprovalConfirmationLike {
  status: ApprovalConfirmationStatus;
  toolCallId: string;
  toolName: string;
  reason: string | null;
}

export type ApprovalToolPart =
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'execution-denied'; reason: string };
    }
  | {
      type: 'tool-approval-response';
      approvalId: string;
      approved: boolean;
      reason?: string;
    };

export type ApprovalResponsePlan =
  | { kind: 'not-ready' }
  | { kind: 'already-ready' }
  | { kind: 'append'; parts: ApprovalToolPart[] };

function messageContentParts(message: ApprovalMessageLike): unknown[] | null {
  const content = (message.content as { content?: unknown })?.content;
  return Array.isArray(content) ? content : null;
}

function findLastAssistantIndex(messages: readonly ApprovalMessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return i;
    }
  }
  return -1;
}

function collectApprovalRequests(parts: unknown[]): ApprovalRequest[] {
  return parts.filter(
    (part): part is ApprovalRequest =>
      (part as { type?: unknown })?.type === 'tool-approval-request' &&
      typeof (part as { approvalId?: unknown })?.approvalId === 'string'
  );
}

function collectResolvedIds(
  messages: readonly ApprovalMessageLike[],
  lastAssistantIndex: number
): Pick<InspectedApprovals, 'respondedApprovalIds' | 'resolvedToolCallIds'> {
  const respondedApprovalIds = new Set<string>();
  const resolvedToolCallIds = new Set<string>();
  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'tool') {
      continue;
    }
    const content = messageContentParts(message);
    if (!content) {
      continue;
    }
    for (const part of content) {
      const typed = part as { type?: unknown; approvalId?: unknown; toolCallId?: unknown };
      if (typed?.type === 'tool-approval-response' && typeof typed.approvalId === 'string') {
        respondedApprovalIds.add(typed.approvalId);
      }
      if (typed?.type === 'tool-result' && typeof typed.toolCallId === 'string') {
        resolvedToolCallIds.add(typed.toolCallId);
      }
    }
  }
  return { respondedApprovalIds, resolvedToolCallIds };
}

export function inspectApprovalMessages(
  messages: readonly ApprovalMessageLike[]
): InspectedApprovals | null {
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) {
    return null;
  }
  const assistantContent = messageContentParts(messages[lastAssistantIndex]);
  if (!assistantContent) {
    return null;
  }
  const requests = collectApprovalRequests(assistantContent);
  if (requests.length === 0) {
    return null;
  }
  return {
    requests,
    ...collectResolvedIds(messages, lastAssistantIndex),
  };
}

function isRequestStillOpen(
  request: ApprovalRequest,
  inspected: InspectedApprovals,
  confirmation: ApprovalConfirmationLike | null
): boolean {
  if (inspected.respondedApprovalIds.has(request.approvalId)) {
    return false;
  }
  const toolCallId = confirmation?.toolCallId ?? request.toolCallId;
  return !inspected.resolvedToolCallIds.has(toolCallId);
}

function buildDecidedPart(
  request: ApprovalRequest,
  confirmation: ApprovalConfirmationLike
): ApprovalToolPart {
  if (confirmation.status === 'cancelled') {
    return {
      type: 'tool-result',
      toolCallId: confirmation.toolCallId,
      toolName: confirmation.toolName,
      output: {
        type: 'execution-denied',
        reason: confirmation.reason ?? 'cancelled',
      },
    };
  }
  const approved = confirmation.status === 'approved';
  return {
    type: 'tool-approval-response',
    approvalId: request.approvalId,
    approved,
    ...(!approved && confirmation.reason ? { reason: confirmation.reason } : {}),
  };
}

export function buildApprovalResponsePlan(
  inspected: InspectedApprovals,
  confirmations: ReadonlyMap<string, ApprovalConfirmationLike | null>
): ApprovalResponsePlan {
  const missing = inspected.requests.filter((request) =>
    isRequestStillOpen(request, inspected, confirmations.get(request.approvalId) ?? null)
  );
  if (missing.length === 0) {
    return { kind: 'already-ready' };
  }

  const parts: ApprovalToolPart[] = [];
  for (const request of missing) {
    const confirmation = confirmations.get(request.approvalId) ?? null;
    if (!confirmation || confirmation.status === 'pending') {
      return { kind: 'not-ready' };
    }
    parts.push(buildDecidedPart(request, confirmation));
  }
  return { kind: 'append', parts };
}
