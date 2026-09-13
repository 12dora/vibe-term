import { describe, expect, test } from 'bun:test';
import { dropInboxMessage, rerollOfferIgnoreReason } from './peer-dc-reroll-offer';
import type { LivePeer } from './peer-reconnect-wake';

function live(patch: Partial<LivePeer> = {}): LivePeer {
  return {
    transport: 'dc',
    rerollCapable: true,
    rtcEpoch: 5,
    ...patch,
  } as LivePeer;
}

describe('rerollOfferIgnoreReason', () => {
  test('非 dc / 无 live 静默 skip；能力、epoch、inflight、角色、冷却分别给出 reason', () => {
    expect(
      rerollOfferIgnoreReason({
        live: undefined,
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBe('skip');
    expect(
      rerollOfferIgnoreReason({
        live: live({ transport: 'relay' }),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBe('skip');
    expect(
      rerollOfferIgnoreReason({
        live: live({ rerollCapable: false }),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBe('not-capable');
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 5,
        inflight: false,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBe('epoch');
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 6,
        inflight: true,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBe('inflight');
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: false,
        answererAllows: true,
      })
    ).toBe('role');
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: false,
      })
    ).toBe('cooldown');
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: false,
        respondsToOurRequest: true,
      })
    ).toBeNull();
    expect(
      rerollOfferIgnoreReason({
        live: live(),
        offerEpoch: 6,
        inflight: false,
        isAnswerer: true,
        answererAllows: true,
      })
    ).toBeNull();
  });
});

describe('dropInboxMessage', () => {
  test('只丢掉指定消息，空了就删 key', () => {
    const inbox = new Map();
    const keep = { message: { sdp: 'keep' }, receivedAt: 1 };
    const drop = { message: { sdp: 'drop' }, receivedAt: 2 };
    inbox.set('p', [keep, drop]);
    dropInboxMessage(inbox, 'p', drop.message as never);
    expect(inbox.get('p')).toEqual([keep]);
    dropInboxMessage(inbox, 'p', keep.message as never);
    expect(inbox.has('p')).toBe(false);
  });
});
