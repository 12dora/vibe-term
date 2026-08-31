export type DirectAttemptRecord = {
  at: number;
  ws: string | null;
  dc: string | null;
  endpointsTried: string[];
};

export function emptyDirectAttempt(at: number): DirectAttemptRecord {
  return { at, ws: null, dc: null, endpointsTried: [] };
}

export function noteWsOutcome(
  attempt: DirectAttemptRecord,
  ws: string | null,
  endpointsTried: string[]
): void {
  attempt.ws = ws;
  attempt.endpointsTried = endpointsTried;
}

export function noteDcOutcome(attempt: DirectAttemptRecord, dc: string | null): void {
  attempt.dc = dc;
}

export function hasDirectFailure(attempt: DirectAttemptRecord): boolean {
  return attempt.ws != null || attempt.dc != null;
}

export function clearedDirectAttempt(prev: DirectAttemptRecord): DirectAttemptRecord {
  return {
    at: prev.at,
    ws: null,
    dc: null,
    endpointsTried: prev.endpointsTried,
  };
}

export function directFailureView(
  attempt: DirectAttemptRecord | undefined
): { at: number; ws: string | null; dc: string | null } | null {
  if (!attempt || !hasDirectFailure(attempt)) return null;
  return { at: attempt.at, ws: attempt.ws, dc: attempt.dc };
}
