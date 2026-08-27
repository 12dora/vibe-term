export interface ApprovalMessageLike {
  role: string;
  content: unknown;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
}

export interface ApprovalConfirmation {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  reason: string | null;
}

export type ApprovalRequestScan =
  | { kind: 'absent' }
  | { kind: 'complete' }
  | { kind: 'open'; requests: ApprovalRequest[] };

export type ResolvedApprovalCall =
  | { status: 'approved'; approvalId: string; approved: true; reason: string | null }
  | { status: 'denied'; approvalId: string; approved: false; reason: string | null }
  | { status: 'cancelled'; toolCallId: string; toolName: string; reason: string };

export function findApprovalRequests(
  messages: readonly ApprovalMessageLike[]
): ApprovalRequestScan {
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) {
    return { kind: 'absent' };
  }
  const requests = extractApprovalRequests(messages[lastAssistantIndex]?.content);
  if (requests.length === 0) {
    return { kind: 'absent' };
  }
  const unresolved = filterUnresolvedRequests(
    requests,
    collectExistingResolutions(messages, lastAssistantIndex)
  );
  if (unresolved.length === 0) {
    return { kind: 'complete' };
  }
  return { kind: 'open', requests: unresolved };
}

export function collectResolvedToolCalls(
  requests: readonly ApprovalRequest[],
  confirmations: readonly ApprovalConfirmation[]
): ResolvedApprovalCall[] | null {
  const byApprovalId = indexConfirmations(confirmations);
  const resolved: ResolvedApprovalCall[] = [];
  for (const request of requests) {
    const item = toResolvedCall(byApprovalId.get(request.approvalId));
    if (!item) {
      return null;
    }
    resolved.push(item);
  }
  return resolved;
}

export function buildApprovalResponseParts(
  resolved: readonly ResolvedApprovalCall[]
): Array<Record<string, unknown>> {
  return resolved.map(toApprovalResponsePart);
}

function findLastAssistantIndex(messages: readonly ApprovalMessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      return i;
    }
  }
  return -1;
}

function extractApprovalRequests(content: unknown): ApprovalRequest[] {
  const parts = extractContentParts(content);
  if (!parts) {
    return [];
  }
  const requests: ApprovalRequest[] = [];
  for (const part of parts) {
    const request = asApprovalRequest(part);
    if (request) {
      requests.push(request);
    }
  }
  return requests;
}

function collectExistingResolutions(
  messages: readonly ApprovalMessageLike[],
  afterIndex: number
): { respondedApprovalIds: Set<string>; resolvedToolCallIds: Set<string> } {
  const respondedApprovalIds = new Set<string>();
  const resolvedToolCallIds = new Set<string>();
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'tool') {
      continue;
    }
    collectResolvedParts(
      extractContentParts(message.content),
      respondedApprovalIds,
      resolvedToolCallIds
    );
  }
  return { respondedApprovalIds, resolvedToolCallIds };
}

function collectResolvedParts(
  parts: unknown[] | null,
  respondedApprovalIds: Set<string>,
  resolvedToolCallIds: Set<string>
): void {
  if (!parts) {
    return;
  }
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.type === 'tool-approval-response' && typeof part.approvalId === 'string') {
      respondedApprovalIds.add(part.approvalId);
    }
    if (part.type === 'tool-result' && typeof part.toolCallId === 'string') {
      resolvedToolCallIds.add(part.toolCallId);
    }
  }
}

function filterUnresolvedRequests(
  requests: readonly ApprovalRequest[],
  existing: { respondedApprovalIds: Set<string>; resolvedToolCallIds: Set<string> }
): ApprovalRequest[] {
  return requests.filter(
    (request) =>
      !existing.respondedApprovalIds.has(request.approvalId) &&
      !existing.resolvedToolCallIds.has(request.toolCallId)
  );
}

function indexConfirmations(
  confirmations: readonly ApprovalConfirmation[]
): Map<string, ApprovalConfirmation> {
  const byApprovalId = new Map<string, ApprovalConfirmation>();
  for (const confirmation of confirmations) {
    if (!byApprovalId.has(confirmation.approvalId)) {
      byApprovalId.set(confirmation.approvalId, confirmation);
    }
  }
  return byApprovalId;
}

function toResolvedCall(
  confirmation: ApprovalConfirmation | undefined
): ResolvedApprovalCall | null {
  if (!confirmation || confirmation.status === 'pending') {
    return null;
  }
  if (confirmation.status === 'cancelled') {
    return {
      status: 'cancelled',
      toolCallId: confirmation.toolCallId,
      toolName: confirmation.toolName,
      reason: confirmation.reason ?? 'cancelled',
    };
  }
  if (confirmation.status === 'approved') {
    return {
      status: 'approved',
      approvalId: confirmation.approvalId,
      approved: true,
      reason: confirmation.reason,
    };
  }
  return {
    status: 'denied',
    approvalId: confirmation.approvalId,
    approved: false,
    reason: confirmation.reason,
  };
}

function toApprovalResponsePart(item: ResolvedApprovalCall): Record<string, unknown> {
  if (item.status === 'cancelled') {
    return {
      type: 'tool-result',
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      output: {
        type: 'execution-denied',
        reason: item.reason,
      },
    };
  }
  return {
    type: 'tool-approval-response',
    approvalId: item.approvalId,
    approved: item.approved,
    ...(!item.approved && item.reason ? { reason: item.reason } : {}),
  };
}

function extractContentParts(content: unknown): unknown[] | null {
  if (!isRecord(content) || !Array.isArray(content.content)) {
    return null;
  }
  return content.content;
}

function asApprovalRequest(part: unknown): ApprovalRequest | null {
  if (!isRecord(part) || part.type !== 'tool-approval-request') {
    return null;
  }
  if (typeof part.approvalId !== 'string') {
    return null;
  }
  return {
    approvalId: part.approvalId,
    toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
