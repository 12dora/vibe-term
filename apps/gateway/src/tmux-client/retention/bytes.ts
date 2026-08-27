import { bytesEqual, bytesHex, copyBytes } from '../../bytes';
import type { PaneIdentity, PaneState, PaneSubscriptionRequest } from './types';

export { bytesEqual, bytesHex, copyBytes };

export function safeCallback(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error('[tmux-client] pane retention consumer callback failed:', error);
  }
}

export function cloneIdentity(state: Pick<PaneState, 'paneId' | 'paneEpoch'>): PaneIdentity {
  return { paneId: state.paneId, paneEpoch: copyBytes(state.paneEpoch) };
}

export function cloneRequest(request: PaneSubscriptionRequest): PaneSubscriptionRequest {
  return {
    paneId: request.paneId,
    paneEpoch: copyBytes(request.paneEpoch),
    cursor: request.cursor
      ? {
          paneEpoch: copyBytes(request.cursor.paneEpoch),
          terminalSeq: request.cursor.terminalSeq,
        }
      : null,
  };
}

export function requestFingerprint(request: PaneSubscriptionRequest): string {
  const cursor = request.cursor
    ? `${bytesHex(request.cursor.paneEpoch)}:${request.cursor.terminalSeq}`
    : '-';
  return `${request.paneId}:${bytesHex(request.paneEpoch)}:${cursor}`;
}

export function subscriptionFingerprint(
  active: readonly PaneSubscriptionRequest[],
  hot: readonly PaneSubscriptionRequest[]
): string {
  const activeParts = active.map(requestFingerprint).sort();
  const hotParts = hot.map(requestFingerprint).sort();
  return `a=${activeParts.join(',')}|h=${hotParts.join(',')}`;
}

export function uniqueRequests(
  requests: readonly PaneSubscriptionRequest[]
): PaneSubscriptionRequest[] {
  const result: PaneSubscriptionRequest[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.paneId)) continue;
    seen.add(request.paneId);
    result.push(request);
  }
  return result;
}
