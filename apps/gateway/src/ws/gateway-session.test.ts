import { describe, expect, test } from 'bun:test';
import type { Carrier, CarrierSendResult } from './carrier';
import { GatewaySession } from './gateway-session';

function createFakeCarrier(label: string): Carrier & {
  label: string;
  drains: number;
  closeCalls: Array<{ code: number; reason: string }>;
} {
  const drainCallbacks: Array<() => void> = [];
  return {
    label,
    drains: 0,
    closeCalls: [],
    send(): CarrierSendResult {
      return 'sent';
    },
    bufferedAmount() {
      return 0;
    },
    onDrain(cb) {
      drainCallbacks.push(cb);
    },
    close(code, reason) {
      this.closeCalls.push({ code, reason });
    },
    terminate() {},
  };
}

describe('GatewaySession', () => {
  test('starts with primary as the only active carrier and independent seq counters', () => {
    const primary = createFakeCarrier('primary');
    const session = new GatewaySession({ primary });
    expect(session.activeCarrier).toBe(primary);
    expect(session.direct).toBeNull();
    expect(session.closed).toBe(false);
    expect(session.borshState.seqGen()).toBe(1);
    expect(session.borshState.seqGen()).toBe(2);
    expect(session.state.wsConnection.seq).toBe(0);
  });

  test('attach/switch/detach keep session protocol state and never reset seq', () => {
    const primary = createFakeCarrier('primary');
    const direct = createFakeCarrier('direct');
    const session = new GatewaySession({ primary });
    session.borshState.negotiated = true;
    session.borshState.maxFrameBytes = 4096;
    session.borshState.seqGen();
    session.borshState.seqGen();
    session.state.wsConnection.seq = 7;

    session.attachCarrier(direct, 'direct');
    expect(session.direct).toBe(direct);
    expect(session.activeCarrier).toBe(primary);

    session.switchActiveCarrier(direct);
    expect(session.activeCarrier).toBe(direct);
    expect(session.borshState.negotiated).toBe(true);
    expect(session.borshState.maxFrameBytes).toBe(4096);
    expect(session.borshState.seqGen()).toBe(3);
    expect(session.state.wsConnection.seq).toBe(7);

    session.detachCarrier(direct);
    expect(session.direct).toBeNull();
    expect(session.activeCarrier).toBe(primary);
    expect(session.borshState.seqGen()).toBe(4);
    expect(session.state.wsConnection.seq).toBe(7);
  });

  test('switchActiveCarrier rejects a carrier that is not attached', () => {
    const session = new GatewaySession({ primary: createFakeCarrier('primary') });
    expect(() => session.switchActiveCarrier(createFakeCarrier('other'))).toThrow(
      'carrier is not attached to this session'
    );
  });

  test('drain from a stale carrier does not count as an active drain', () => {
    const primary = createFakeCarrier('primary');
    const direct = createFakeCarrier('direct');
    const session = new GatewaySession({ primary });
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);

    expect(session.handleCarrierDrain(primary)).toBe(false);
    expect(session.isActiveCarrier(primary)).toBe(false);
    expect(session.handleCarrierDrain(direct)).toBe(true);
  });

  test('carriers() lists primary and the attached direct', () => {
    const primary = createFakeCarrier('primary');
    const session = new GatewaySession({ primary });
    expect(session.carriers()).toEqual([primary]);

    const direct = createFakeCarrier('direct');
    session.attachCarrier(direct, 'direct');
    expect(session.carriers()).toEqual([primary, direct]);
  });

  test('attachCarrier throws when the same carrier is attached twice', () => {
    const primary = createFakeCarrier('primary');
    const direct = createFakeCarrier('direct');
    const session = new GatewaySession({ primary });
    expect(() => session.attachCarrier(primary, 'direct')).toThrow(
      'carrier is already attached to this session'
    );
    session.attachCarrier(direct, 'direct');
    expect(() => session.attachCarrier(direct, 'direct')).toThrow(
      'carrier is already attached to this session'
    );
  });

  test('attachCarrier replaces an existing direct atomically', () => {
    const primary = createFakeCarrier('primary');
    const oldDirect = createFakeCarrier('old-direct');
    const nextDirect = createFakeCarrier('next-direct');
    const session = new GatewaySession({ primary });
    const detached: Carrier[] = [];
    session.onCarrierDetached = (carrier) => {
      detached.push(carrier);
    };

    session.attachCarrier(oldDirect, 'direct');
    session.switchActiveCarrier(oldDirect);
    session.attachCarrier(nextDirect, 'direct');

    expect(session.activeCarrier).toBe(primary);
    expect(session.direct).toBe(nextDirect);
    expect(session.carriers()).toEqual([primary, nextDirect]);
    expect(detached).toEqual([oldDirect]);
    expect(oldDirect.closeCalls).toEqual([{ code: 1000, reason: 'direct carrier replaced' }]);
    expect(nextDirect.closeCalls).toEqual([]);
  });
});
