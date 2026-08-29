import { cloneRequest, copyBytes } from './bytes';
import type {
  PaneSubscriptionRejection,
  PaneSubscriptionRejectionReason,
  PaneSubscriptionRequest,
} from './types';

export interface SubscriptionAdmissionInput<T> {
  mode: 'active' | 'hot';
  requests: readonly PaneSubscriptionRequest[];
  occupied: ReadonlySet<string>;
  limit: number;
  lookupPane: (paneId: string) => T | undefined;
  validate: (
    state: T | undefined,
    request: PaneSubscriptionRequest
  ) => PaneSubscriptionRejectionReason | null;
}

export interface SubscriptionAdmissionResult {
  accepted: Map<string, PaneSubscriptionRequest>;
  rejected: PaneSubscriptionRejection[];
}

export function acceptSubscriptionRequests<T>(
  input: SubscriptionAdmissionInput<T>
): SubscriptionAdmissionResult {
  const rejected: PaneSubscriptionRejection[] = [];
  const accepted = new Map<string, PaneSubscriptionRequest>();
  const prospective = new Set(input.occupied);
  for (const request of input.requests) {
    const rejection = input.validate(input.lookupPane(request.paneId), request);
    if (rejection) {
      rejected.push({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
        reason: rejection,
      });
      continue;
    }
    if (!prospective.has(request.paneId) && prospective.size >= input.limit) {
      rejected.push({
        paneId: request.paneId,
        paneEpoch: copyBytes(request.paneEpoch),
        reason: 'resource_exhausted',
      });
      continue;
    }
    accepted.set(request.paneId, cloneRequest(request));
    prospective.add(request.paneId);
  }
  return { accepted, rejected };
}
