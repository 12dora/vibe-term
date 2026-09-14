import type { RelayLinkErrorCode } from '@vibeterm/shared/relay';
import { UPLINK_RTT_MIN_SAMPLES, isRttSwitchWorth } from './uplink-nearest-switch';
import { UPLINK_RTT_EWMA_ALPHA, UPLINK_RTT_SWITCH_DWELL_MS } from './uplink-pool';
import { sameHubUrl } from './uplink-pool-url';

export const RELAY_SCORE_PATH_WEIGHT = 0.15;
export const RELAY_SCORE_LOAD_WEIGHT = 0.05;
export const RELAY_SCORE_FAILURE_PENALTY_MS = 500;
export const RELAY_SCORE_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const RELAY_RTT_EWMA_ALPHA = UPLINK_RTT_EWMA_ALPHA;
export const RELAY_AUTO_SWITCH_DWELL_MS = UPLINK_RTT_SWITCH_DWELL_MS;
export const RELAY_AUTO_SWITCH_CONSECUTIVE = UPLINK_RTT_MIN_SAMPLES;

export type RelayScoreInput = {
  url: string;
  online: boolean;
  kicked: boolean;
  ewmaRtt: number | null;
  rttSamples: number;
  pathBestMs?: number | null;
  peersOnline?: number | null;
  maxNodes?: number | null;
  lastFailureAt?: number | null;
};

export type RelayHysteresis = {
  consecutiveUrl: string | null;
  consecutiveCount: number;
};

export type RelayScoreMap = Map<string, number | null>;

export type RelaySwitchDecision =
  | { type: 'switch'; url: string; score: number; currentScore: number }
  | { type: 'hold'; reason: string; url?: string; score?: number; currentScore?: number }
  | { type: 'none' };

export type RelayConsiderResult = {
  decision: RelaySwitchDecision;
  hysteresis: RelayHysteresis;
  scores: RelayScoreMap;
  lastConsiderAt: number;
};

const CONNECT_AUTH_CODES: ReadonlySet<RelayLinkErrorCode> = new Set([
  'connect-failed',
  'connect-timeout',
  'auth-timeout',
  'auth-rejected',
]);

export function isConnectAuthFailure(code: RelayLinkErrorCode | null | undefined): boolean {
  return code != null && CONNECT_AUTH_CODES.has(code);
}

export function resetRelayHysteresis(): RelayHysteresis {
  return { consecutiveUrl: null, consecutiveCount: 0 };
}

export function updateRttEwma(
  prev: { ewma: number; samples: number } | null,
  sample: number
): { ewma: number; samples: number } {
  if (!prev || prev.samples < 1) return { ewma: sample, samples: 1 };
  return {
    ewma: RELAY_RTT_EWMA_ALPHA * sample + (1 - RELAY_RTT_EWMA_ALPHA) * prev.ewma,
    samples: prev.samples + 1,
  };
}

export function scoreRelay(row: RelayScoreInput, now: number): number | null {
  if (row.kicked || !row.online) return null;
  if (row.rttSamples < UPLINK_RTT_MIN_SAMPLES || row.ewmaRtt == null) return null;
  let score = row.ewmaRtt + pathTerm(row) + loadTerm(row);
  if (failurePenaltyApplies(row.lastFailureAt, now)) score += RELAY_SCORE_FAILURE_PENALTY_MS;
  return score;
}

export function scoreRelays(rows: readonly RelayScoreInput[], now: number): RelayScoreMap {
  const scores: RelayScoreMap = new Map();
  for (const row of rows) scores.set(row.url, scoreRelay(row, now));
  return scores;
}

export function pinIsFrozen(
  preferredUrl: string | null,
  rows: readonly RelayScoreInput[]
): boolean {
  if (!preferredUrl) return false;
  const pin = rows.find((row) => sameHubUrl(row.url, preferredUrl));
  return Boolean(pin && !pin.kicked);
}

export function considerAutoSwitch(input: {
  rows: readonly RelayScoreInput[];
  currentUrl: string | null;
  preferredUrl: string | null;
  lastAutoSwitchAt: number;
  now: number;
  hysteresis: RelayHysteresis;
  dwellMs?: number;
  lastConsiderAt?: number;
  intervalMs?: number;
}): RelayConsiderResult {
  const scores = scoreRelays(input.rows, input.now);
  const lastConsiderAt = input.lastConsiderAt ?? 0;
  if (pinIsFrozen(input.preferredUrl, input.rows)) {
    return {
      decision: { type: 'hold', reason: 'pinned' },
      hysteresis: resetRelayHysteresis(),
      scores,
      lastConsiderAt,
    };
  }
  const currentScore = input.currentUrl ? scores.get(input.currentUrl) : null;
  const best = lowestScored(scores, input.currentUrl);
  if (
    currentScore == null ||
    !best ||
    (input.currentUrl && sameHubUrl(best.url, input.currentUrl))
  ) {
    return {
      decision: { type: 'none' },
      hysteresis: resetRelayHysteresis(),
      scores,
      lastConsiderAt,
    };
  }
  if (!isRttSwitchWorth(currentScore, best.score)) {
    return {
      decision: { type: 'none' },
      hysteresis: resetRelayHysteresis(),
      scores,
      lastConsiderAt,
    };
  }
  if (inDwell(input.lastAutoSwitchAt, input.now, input.dwellMs ?? RELAY_AUTO_SWITCH_DWELL_MS)) {
    return holdResult({
      scores,
      hysteresis: input.hysteresis,
      reason: 'dwell',
      best,
      currentScore,
      lastConsiderAt,
    });
  }
  const advanced = advanceHysteresis(
    input.hysteresis,
    best.url,
    input.now,
    lastConsiderAt,
    input.intervalMs
  );
  if (advanced.hysteresis.consecutiveCount < RELAY_AUTO_SWITCH_CONSECUTIVE) {
    return holdResult({
      scores,
      hysteresis: advanced.hysteresis,
      reason: 'consecutive',
      best,
      currentScore,
      lastConsiderAt: advanced.lastConsiderAt,
    });
  }
  return {
    decision: { type: 'switch', url: best.url, score: best.score, currentScore },
    hysteresis: advanced.hysteresis,
    scores,
    lastConsiderAt: advanced.lastConsiderAt,
  };
}

function pathTerm(row: RelayScoreInput): number {
  return row.pathBestMs != null && row.pathBestMs > 0
    ? RELAY_SCORE_PATH_WEIGHT * row.pathBestMs
    : 0;
}

function loadTerm(row: RelayScoreInput): number {
  const maxNodes = row.maxNodes;
  const peers = row.peersOnline;
  if (maxNodes == null || maxNodes <= 0 || peers == null || peers < 0) return 0;
  return RELAY_SCORE_LOAD_WEIGHT * (peers / maxNodes) * 1000;
}

function failurePenaltyApplies(lastFailureAt: number | null | undefined, now: number): boolean {
  if (lastFailureAt == null) return false;
  const age = now - lastFailureAt;
  return age >= 0 && age < RELAY_SCORE_FAILURE_WINDOW_MS;
}

function lowestScored(
  scores: RelayScoreMap,
  currentUrl: string | null
): { url: string; score: number } | null {
  let best: { url: string; score: number } | null = null;
  for (const [url, score] of scores) {
    if (score == null) continue;
    if (
      !best ||
      score < best.score ||
      (score === best.score && isPreferredTie(url, currentUrl, best.url))
    ) {
      best = { url, score };
    }
  }
  return best;
}

function isPreferredTie(url: string, currentUrl: string | null, bestUrl: string): boolean {
  return Boolean(currentUrl && sameHubUrl(url, currentUrl) && !sameHubUrl(bestUrl, currentUrl));
}

function inDwell(lastAutoSwitchAt: number, now: number, dwellMs: number): boolean {
  return lastAutoSwitchAt > 0 && now - lastAutoSwitchAt < dwellMs;
}

function advanceHysteresis(
  prev: RelayHysteresis,
  url: string,
  now: number,
  lastConsiderAt: number,
  intervalMs: number | undefined
): { hysteresis: RelayHysteresis; lastConsiderAt: number } {
  if (!prev.consecutiveUrl || !sameHubUrl(prev.consecutiveUrl, url)) {
    return { hysteresis: { consecutiveUrl: url, consecutiveCount: 1 }, lastConsiderAt: now };
  }
  if (intervalMs != null && lastConsiderAt > 0 && now - lastConsiderAt < intervalMs) {
    return { hysteresis: prev, lastConsiderAt };
  }
  return {
    hysteresis: {
      consecutiveUrl: prev.consecutiveUrl,
      consecutiveCount: prev.consecutiveCount + 1,
    },
    lastConsiderAt: now,
  };
}

function holdResult(input: {
  scores: RelayScoreMap;
  hysteresis: RelayHysteresis;
  reason: string;
  best: { url: string; score: number };
  currentScore: number;
  lastConsiderAt: number;
}): RelayConsiderResult {
  return {
    decision: {
      type: 'hold',
      reason: input.reason,
      url: input.best.url,
      score: input.best.score,
      currentScore: input.currentScore,
    },
    hysteresis: input.hysteresis,
    scores: input.scores,
    lastConsiderAt: input.lastConsiderAt,
  };
}
