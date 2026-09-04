export type UrlDiag = {
  lastError: string | null;
  lastErrorAt: number | null;
  lastAttemptAt: number | null;
  rttMs: number | null;
  rttAt: number | null;
  rttSamples: number;
};

export function emptyUplinkDiag(): UrlDiag {
  return {
    lastError: null,
    lastErrorAt: null,
    lastAttemptAt: null,
    rttMs: null,
    rttAt: null,
    rttSamples: 0,
  };
}

export function mergeUplinkDiag(prev: UrlDiag, patch: Partial<UrlDiag>): UrlDiag {
  return {
    lastError: patch.lastError !== undefined ? patch.lastError : prev.lastError,
    lastErrorAt: patch.lastErrorAt !== undefined ? patch.lastErrorAt : prev.lastErrorAt,
    lastAttemptAt: patch.lastAttemptAt !== undefined ? patch.lastAttemptAt : prev.lastAttemptAt,
    rttMs: patch.rttMs !== undefined ? patch.rttMs : prev.rttMs,
    rttAt: patch.rttAt !== undefined ? patch.rttAt : prev.rttAt,
    rttSamples: patch.rttSamples !== undefined ? patch.rttSamples : prev.rttSamples,
  };
}
