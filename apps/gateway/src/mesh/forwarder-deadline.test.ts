import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_DIAL_RTT_MS, adaptiveDeadlineMs, nestedDialBudgetsMs } from '@vibeterm/shared/net';
import {
  authorizedHttpDeadlineMs,
  deadlineRttMs,
  forwardLinkDeadlineFor,
  setForwardLinkDeadlineMs,
} from './forwarder-deadline';
import type { PeerLinkProvider } from './mesh-deps';
import { resetPeerRttLookupForTests } from './peer-manager-state';

afterEach(() => {
  setForwardLinkDeadlineMs(0);
  resetPeerRttLookupForTests();
});

function peersWith(rttForNode: (id: string) => number): PeerLinkProvider {
  return { rttForNode } as PeerLinkProvider;
}

describe('forwarder deadline RTT source', () => {
  test('显式有限 rttMs 最先；否则 peers.rttForNode；再否则悲观 lookup', () => {
    const peers = peersWith(() => 2500);
    expect(deadlineRttMs('n', 40, peers)).toBe(40);
    expect(deadlineRttMs('n', 0, peers)).toBe(0);
    expect(deadlineRttMs('n', null, peers)).toBe(2500);
    expect(deadlineRttMs('n', undefined, peers)).toBe(2500);
    expect(deadlineRttMs('n', Number.NaN, peers)).toBe(2500);
    expect(deadlineRttMs('n')).toBe(DEFAULT_DIAL_RTT_MS);
  });

  test('forward / authorizedHttp 预算跟随同一套 RTT 源', () => {
    const peers = peersWith(() => 2500);
    expect(forwardLinkDeadlineFor('n', null, peers)).toBe(nestedDialBudgetsMs(2500).forwardMs);
    expect(authorizedHttpDeadlineMs('n', null, peers)).toBe(
      adaptiveDeadlineMs({ rttMs: 2500, factor: 8, minMs: 10_000, maxMs: 30_000 })
    );
    expect(forwardLinkDeadlineFor('n', 40, peers)).toBe(nestedDialBudgetsMs(40).forwardMs);
    expect(forwardLinkDeadlineFor('n')).toBe(nestedDialBudgetsMs(DEFAULT_DIAL_RTT_MS).forwardMs);
  });

  test('setForwardLinkDeadlineMs 覆盖自适应缺省，<=0 恢复', () => {
    setForwardLinkDeadlineMs(123);
    expect(forwardLinkDeadlineFor('n', 2500)).toBe(123);
    setForwardLinkDeadlineMs(0);
    expect(forwardLinkDeadlineFor('n', 2500)).toBe(nestedDialBudgetsMs(2500).forwardMs);
  });
});
