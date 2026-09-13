import { describe, expect, test } from 'bun:test';
import {
  RELAY_AUTO_SWITCH_DWELL_MS,
  RELAY_SCORE_FAILURE_PENALTY_MS,
  RELAY_SCORE_FAILURE_WINDOW_MS,
  type RelayScoreInput,
  considerAutoSwitch,
  resetRelayHysteresis,
  scoreRelay,
  updateRttEwma,
} from './relay-best-select';

const SH = 'https://sh.example';
const JP = 'https://jp.example';
const TK = 'https://tk.example';
const NOW = 1_000_000;

function row(over: Partial<RelayScoreInput> & { url: string }): RelayScoreInput {
  return {
    online: true,
    kicked: false,
    ewmaRtt: 40,
    rttSamples: 2,
    pathBestMs: null,
    peersOnline: null,
    maxNodes: null,
    lastFailureAt: null,
    ...over,
  };
}

describe('scoreRelay', () => {
  test('scoreMs = ewma + 0.15 path + 0.05 load + failure penalty', () => {
    expect(
      scoreRelay(
        row({
          url: SH,
          ewmaRtt: 100,
          pathBestMs: 20,
          peersOnline: 4,
          maxNodes: 8,
        }),
        NOW
      )
    ).toBe(100 + 0.15 * 20 + 0.05 * (4 / 8) * 1000);
  });

  test('missing RTT samples skip the relay', () => {
    expect(scoreRelay(row({ url: SH, rttSamples: 1, ewmaRtt: 12 }), NOW)).toBeNull();
    expect(scoreRelay(row({ url: SH, rttSamples: 0, ewmaRtt: 12 }), NOW)).toBeNull();
    expect(scoreRelay(row({ url: SH, rttSamples: 2, ewmaRtt: null }), NOW)).toBeNull();
  });

  test('kicked and offline relays are skipped', () => {
    expect(scoreRelay(row({ url: SH, kicked: true }), NOW)).toBeNull();
    expect(scoreRelay(row({ url: SH, online: false }), NOW)).toBeNull();
  });

  test('unknown path / load terms are zero', () => {
    expect(scoreRelay(row({ url: SH, ewmaRtt: 40 }), NOW)).toBe(40);
  });

  test('failure penalty applies for 5 min after a classified failure', () => {
    expect(scoreRelay(row({ url: SH, ewmaRtt: 40, lastFailureAt: NOW - 60_000 }), NOW)).toBe(
      40 + RELAY_SCORE_FAILURE_PENALTY_MS
    );
    expect(
      scoreRelay(
        row({ url: SH, ewmaRtt: 40, lastFailureAt: NOW - RELAY_SCORE_FAILURE_WINDOW_MS }),
        NOW
      )
    ).toBe(40);
  });

  test('load term breaks a tie: higher occupancy scores worse', () => {
    const light = scoreRelay(row({ url: SH, ewmaRtt: 50, peersOnline: 1, maxNodes: 10 }), NOW);
    const heavy = scoreRelay(row({ url: JP, ewmaRtt: 50, peersOnline: 9, maxNodes: 10 }), NOW);
    expect(light).toBe(50 + 5);
    expect(heavy).toBe(50 + 45);
    expect(light!).toBeLessThan(heavy!);
  });
});

describe('updateRttEwma', () => {
  test('alpha 0.3 matches uplink EWMA', () => {
    const first = updateRttEwma(null, 100);
    expect(first).toEqual({ ewma: 100, samples: 1 });
    const second = updateRttEwma(first, 10);
    expect(second.samples).toBe(2);
    expect(second.ewma).toBeCloseTo(0.3 * 10 + 0.7 * 100);
  });
});

describe('considerAutoSwitch', () => {
  const far = row({ url: SH, ewmaRtt: 100 });
  const near = row({ url: JP, ewmaRtt: 40 });

  test('margin requires max(15ms, 30% of current)', () => {
    const tight = considerAutoSwitch({
      rows: [row({ url: SH, ewmaRtt: 100 }), row({ url: JP, ewmaRtt: 90 })],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: resetRelayHysteresis(),
    });
    expect(tight.decision.type).toBe('none');

    const ratioFail = considerAutoSwitch({
      rows: [row({ url: SH, ewmaRtt: 100 }), row({ url: JP, ewmaRtt: 80 })],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: resetRelayHysteresis(),
    });
    expect(ratioFail.decision.type).toBe('none');
  });

  test('requires the margin on 2 consecutive evaluations', () => {
    const first = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: resetRelayHysteresis(),
    });
    expect(first.decision).toMatchObject({ type: 'hold', reason: 'consecutive', url: JP });
    expect(first.hysteresis).toEqual({ consecutiveUrl: JP, consecutiveCount: 1 });

    const second = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: first.hysteresis,
    });
    expect(second.decision).toMatchObject({
      type: 'switch',
      url: JP,
      score: 40,
      currentScore: 100,
    });
  });

  test('a different candidate resets the consecutive counter', () => {
    const first = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: resetRelayHysteresis(),
    });
    const flipped = considerAutoSwitch({
      rows: [far, row({ url: TK, ewmaRtt: 30 })],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: first.hysteresis,
    });
    expect(flipped.decision).toMatchObject({ type: 'hold', reason: 'consecutive', url: TK });
    expect(flipped.hysteresis).toEqual({ consecutiveUrl: TK, consecutiveCount: 1 });
  });

  test('dwell blocks auto switch for 10 min', () => {
    const ready = { consecutiveUrl: JP, consecutiveCount: 2 };
    const blocked = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: NOW - 60_000,
      now: NOW,
      hysteresis: ready,
    });
    expect(blocked.decision).toMatchObject({ type: 'hold', reason: 'dwell', url: JP });
    expect(NOW - 60_000 + RELAY_AUTO_SWITCH_DWELL_MS).toBeGreaterThan(NOW);

    const after = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: NOW - RELAY_AUTO_SWITCH_DWELL_MS,
      now: NOW,
      hysteresis: ready,
    });
    expect(after.decision).toMatchObject({ type: 'switch', url: JP });
  });

  test('pin freeze: preferred online and not kicked wins', () => {
    const result = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: SH,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: { consecutiveUrl: JP, consecutiveCount: 2 },
    });
    expect(result.decision).toMatchObject({ type: 'hold', reason: 'pinned' });
    expect(result.scores.get(JP)).toBe(40);
  });

  test('pin kicked or gone is treated as unset', () => {
    const kicked = considerAutoSwitch({
      rows: [
        row({ url: SH, ewmaRtt: 100, kicked: true, online: false }),
        row({ url: JP, ewmaRtt: 100 }),
        row({ url: TK, ewmaRtt: 40 }),
      ],
      currentUrl: JP,
      preferredUrl: SH,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: { consecutiveUrl: TK, consecutiveCount: 1 },
    });
    expect(kicked.decision).toMatchObject({ type: 'switch', url: TK });

    const gone = considerAutoSwitch({
      rows: [far, near],
      currentUrl: SH,
      preferredUrl: 'https://missing.example',
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: { consecutiveUrl: JP, consecutiveCount: 1 },
    });
    expect(gone.decision).toMatchObject({ type: 'switch', url: JP });
  });

  test('offline and kicked candidates are not picked', () => {
    const result = considerAutoSwitch({
      rows: [
        far,
        row({ url: JP, ewmaRtt: 10, online: false }),
        row({ url: TK, ewmaRtt: 10, kicked: true }),
      ],
      currentUrl: SH,
      preferredUrl: null,
      lastAutoSwitchAt: 0,
      now: NOW,
      hysteresis: resetRelayHysteresis(),
    });
    expect(result.decision.type).toBe('none');
    expect(result.scores.get(JP)).toBeNull();
    expect(result.scores.get(TK)).toBeNull();
  });
});
