import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import { CanonicalFrameSizer } from './frame-sizer';

const PANE = {
  deviceId: 'device-a',
  serverEpoch: new Uint8Array(16).fill(0x11),
  paneId: '%1',
};
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const REQUEST_ID = new Uint8Array(16).fill(0x33);

describe('canonical frame sizer', () => {
  test('binary-searches the largest payload that still fits the negotiated frame', () => {
    const sizer = new CanonicalFrameSizer(512);
    const maxPane = sizer.maxPaneDataBytes(PANE, PANE_EPOCH);
    expect(maxPane).toBeGreaterThan(0);
    expect(
      sizer.eventFits({
        PaneData: {
          pane: PANE,
          paneEpoch: PANE_EPOCH,
          seqStart: 0n,
          seqEnd: BigInt(maxPane),
          data: new Uint8Array(maxPane),
        },
      })
    ).toBe(true);
    expect(
      sizer.eventFits({
        PaneData: {
          pane: PANE,
          paneEpoch: PANE_EPOCH,
          seqStart: 0n,
          seqEnd: BigInt(maxPane + 1),
          data: new Uint8Array(maxPane + 1),
        },
      })
    ).toBe(false);

    const maxChunk = sizer.maxContentChunkBytes('screen', REQUEST_ID);
    expect(maxChunk).toBeGreaterThan(0);
    expect(maxChunk).toBeLessThan(512);
    expect(
      wsBorsh.encodeCanonicalEventPayload({
        ScreenChunk: { requestId: REQUEST_ID, offset: 0, data: new Uint8Array(maxChunk) },
      }).byteLength + 16
    ).toBeLessThanOrEqual(512);
  });
});
