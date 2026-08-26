import { wsBorsh } from '@tmex/shared';

import { ENVELOPE_BYTES } from './bytes';
import type { CanonicalEvent, CanonicalPaneTarget } from './types';

export class CanonicalFrameSizer {
  constructor(readonly maxFrameBytes: number) {}

  eventFits(event: CanonicalEvent): boolean {
    try {
      return (
        wsBorsh.encodeCanonicalEventPayload(event).byteLength + ENVELOPE_BYTES <= this.maxFrameBytes
      );
    } catch {
      return false;
    }
  }

  maxVariableDataBytes(build: (data: Uint8Array) => CanonicalEvent): number {
    let low = 0;
    let high = this.maxFrameBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.eventFits(build(new Uint8Array(middle)))) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  maxPaneDataBytes(target: CanonicalPaneTarget, paneEpoch: Uint8Array): number {
    return this.maxVariableDataBytes((data) => ({
      PaneData: {
        pane: target,
        paneEpoch,
        seqStart: 0n,
        seqEnd: BigInt(data.byteLength),
        data,
      },
    }));
  }

  maxContentChunkBytes(kind: 'screen' | 'history', requestId: Uint8Array): number {
    return this.maxVariableDataBytes((data) =>
      kind === 'screen'
        ? { ScreenChunk: { requestId, offset: 0, data } }
        : { HistoryChunk: { requestId, offset: 0, data } }
    );
  }
}
