import { afterEach, describe, expect, test } from 'bun:test';
import { acquirePeerStreamSlot, peerStreamSlotsInUse, resetPeerStreamSlots } from './budget';
import { PORT_MAP_MAX_PEER_STREAMS } from './types';

const PEER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

describe('portmap peer stream budget', () => {
  afterEach(() => resetPeerStreamSlots());

  test('shares one budget across everything targeting the same peer', () => {
    const first = acquirePeerStreamSlot(PEER, 2);
    const second = acquirePeerStreamSlot(PEER, 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(peerStreamSlotsInUse(PEER)).toBe(2);
    // 第三条即使来自另一条映射，也共用同一份名额
    expect(acquirePeerStreamSlot(PEER, 2)).toBeNull();
    first?.release();
    expect(peerStreamSlotsInUse(PEER)).toBe(1);
    expect(acquirePeerStreamSlot(PEER, 2)).not.toBeNull();
  });

  test('releasing twice only gives back one slot', () => {
    const slot = acquirePeerStreamSlot(PEER, 1);
    slot?.release();
    slot?.release();
    expect(peerStreamSlotsInUse(PEER)).toBe(0);
    expect(acquirePeerStreamSlot(PEER, 1)).not.toBeNull();
  });

  test('counts each peer separately and defaults to the link budget', () => {
    for (let i = 0; i < PORT_MAP_MAX_PEER_STREAMS; i += 1) {
      expect(acquirePeerStreamSlot(PEER)).not.toBeNull();
    }
    expect(acquirePeerStreamSlot(PEER)).toBeNull();
    expect(acquirePeerStreamSlot(OTHER)).not.toBeNull();
    expect(peerStreamSlotsInUse(OTHER)).toBe(1);
  });
});
