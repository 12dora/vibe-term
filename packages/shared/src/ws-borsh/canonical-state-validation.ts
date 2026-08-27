// canonical 事件的跨字段语义约束：编码与解码两侧共用，避免只有编码端拦得住非法组合。

import type { CanonicalEvent } from './canonical-state';
import { ERROR_INVALID_FRAME, WsBorshError } from './errors';

export function assertCanonicalEventSemantics(event: CanonicalEvent): void {
  if (!('PaneData' in event)) return;
  const { seqStart, seqEnd, data } = event.PaneData;
  if (seqEnd < seqStart || seqEnd - seqStart !== BigInt(data.byteLength)) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'PaneData sequence range mismatch');
  }
}
