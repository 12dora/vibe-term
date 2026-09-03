import { describe, expect, test } from 'bun:test';
import { CanonicalLiveReplay } from './canonical-live-replay';
import type { GatewayPaneScreenSnapshot, GatewayTerminalData } from './transport-types';

const PANE_EPOCH = new Uint8Array(16).fill(1);
const HISTORY_EPOCH = new Uint8Array(16).fill(2);

function screen(paneId: string): GatewayPaneScreenSnapshot {
  return {
    deviceId: 'device-a',
    paneId,
    paneEpoch: PANE_EPOCH,
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: new Uint8Array(),
    historyCursor: {
      paneEpoch: PANE_EPOCH,
      historyEpoch: HISTORY_EPOCH,
      beforeLine: 10,
    },
  };
}

function live(paneId: string, seqStart: bigint, bytes: number): GatewayTerminalData {
  return {
    deviceId: 'device-a',
    paneId,
    paneEpoch: PANE_EPOCH,
    seqStart,
    seqEnd: seqStart + BigInt(bytes),
    data: new Uint8Array(bytes).fill(1),
  };
}

describe('CanonicalLiveReplay', () => {
  test('evicts an older pane when the total budget fills without starving the active pane', () => {
    const replay = new CanonicalLiveReplay(4, 6);
    replay.begin(screen('%1'));
    replay.begin(screen('%2'));
    replay.begin(screen('%3'));
    expect(replay.capture(live('%1', 0n, 3))).toBeNull();
    expect(replay.capture(live('%2', 0n, 3))).toBeNull();

    expect(replay.capture(live('%3', 0n, 2))).toBeNull();
    expect(replay.capture(live('%3', 2n, 1))).toBeNull();

    expect(
      replay.historyPage({
        deviceId: 'device-a',
        paneId: '%1',
        paneEpoch: PANE_EPOCH,
        historyEpoch: HISTORY_EPOCH,
        lineStart: 0,
        lineEnd: 10,
        truncated: false,
        data: new Uint8Array(),
        nextCursor: null,
      })
    ).toMatchObject({ tracked: true, valid: false, reason: 'resource_exhausted' });
    expect(
      replay
        .historyPage({
          deviceId: 'device-a',
          paneId: '%3',
          paneEpoch: PANE_EPOCH,
          historyEpoch: HISTORY_EPOCH,
          lineStart: 0,
          lineEnd: 10,
          truncated: false,
          data: new Uint8Array(),
          nextCursor: null,
        })
        .frames.map((frame) => frame.data.byteLength)
    ).toEqual([2, 1]);
  });
});
