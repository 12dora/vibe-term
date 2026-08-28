import { wsBorsh } from '@tmex/shared';

import { ENVELOPE_BYTES } from './bytes';
import { canonicalEventPayloadBytes } from './encoded-size';
import type { CanonicalEvent, CanonicalPaneTarget } from './types';

const EMPTY = new Uint8Array();

export class CanonicalFrameSizer {
  private readonly maxDataByKey = new Map<string, number>();

  constructor(readonly maxFrameBytes: number) {}

  eventFits(event: CanonicalEvent): boolean {
    const payload = canonicalEventPayloadBytes(event);
    if (payload == null) return false;
    if (payload > wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES) return false;
    return payload + ENVELOPE_BYTES <= this.maxFrameBytes;
  }

  maxPaneDataBytes(target: CanonicalPaneTarget, paneEpoch: Uint8Array): number {
    const key = `PaneData\0${target.deviceId}\0${target.paneId}\0${target.serverEpoch.byteLength}\0${paneEpoch.byteLength}`;
    return this.cachedMaxData(key, () =>
      this.maxDataForEmpty({
        PaneData: {
          pane: target,
          paneEpoch,
          seqStart: 0n,
          seqEnd: 0n,
          data: EMPTY,
        },
      })
    );
  }

  maxContentChunkBytes(kind: 'screen' | 'history', requestId: Uint8Array): number {
    const key = `${kind}Chunk\0${requestId.byteLength}`;
    return this.cachedMaxData(key, () => {
      const chunk = { requestId, offset: 0, data: EMPTY };
      return this.maxDataForEmpty(
        kind === 'screen' ? { ScreenChunk: chunk } : { HistoryChunk: chunk }
      );
    });
  }

  private cachedMaxData(key: string, compute: () => number): number {
    const cached = this.maxDataByKey.get(key);
    if (cached != null) return cached;
    const value = compute();
    this.maxDataByKey.set(key, value);
    return value;
  }

  private maxDataForEmpty(emptyEvent: CanonicalEvent): number {
    const prefix = canonicalEventPayloadBytes(emptyEvent);
    if (prefix == null) return 0;
    const maxPayload = Math.min(
      this.maxFrameBytes - ENVELOPE_BYTES,
      wsBorsh.CANONICAL_STATE_MAX_PAYLOAD_BYTES
    );
    return Math.max(0, maxPayload - prefix);
  }
}
