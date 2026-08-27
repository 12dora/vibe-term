import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createFakeCarrier, createGatewaySession } from '../../ws/test-helpers';
import { CarrierSwitchController, type DirectCarrier } from './carrier-switch';
import { DataChannelCarrier } from './data-channel-carrier';
import { pairDataChannels } from './test-fakes';

function decodeSwitch(payload: Uint8Array): { epoch: number; to: number } {
  return wsBorsh.decodePayload(wsBorsh.schema.CarrierSwitchSchema, payload);
}

describe('CarrierSwitchController', () => {
  test('buffers direct inbound until matching ACK then flushes in order', () => {
    const session = createGatewaySession();
    const [local, remote] = pairDataChannels('sess');
    const direct = new DataChannelCarrier(local) as DirectCarrier;
    const delivered: string[] = [];
    const controls: Array<{ kind: number; payload: Uint8Array }> = [];
    const barrier = new CarrierSwitchController({
      sendControl(_session, kind, payload) {
        controls.push({ kind, payload });
      },
      deliverInbound(_session, bytes) {
        delivered.push(new TextDecoder().decode(bytes));
      },
    });

    barrier.attachDirect(session, direct);
    expect(session.direct).toBe(direct);
    expect(session.activeCarrier).toBe(direct);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.kind).toBe(wsBorsh.KIND_CARRIER_SWITCH);
    const sent = decodeSwitch(controls[0]?.payload as Uint8Array);
    expect(sent.to).toBe(wsBorsh.CARRIER_SWITCH_TO_DIRECT);
    expect(sent.epoch).toBe(1);

    remote.sendMessageBinary(
      Buffer.from([0, 0, 0, 1, 0, 0, 1, 0, ...new TextEncoder().encode('A')])
    );
    remote.sendMessageBinary(
      Buffer.from([0, 0, 0, 2, 0, 0, 1, 0, ...new TextEncoder().encode('B')])
    );
    expect(delivered).toEqual([]);

    barrier.handleAck(session, 0);
    expect(delivered).toEqual([]);
    expect(session.activeCarrier).toBe(direct);

    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(direct);
    expect(delivered).toEqual(['A', 'B']);

    remote.sendMessageBinary(
      Buffer.from([0, 0, 0, 3, 0, 0, 1, 0, ...new TextEncoder().encode('C')])
    );
    expect(delivered).toEqual(['A', 'B', 'C']);
  });

  test('ignores ACK for a stale epoch after a later switch', () => {
    const session = createGatewaySession();
    const [local] = pairDataChannels('sess');
    const first = new DataChannelCarrier(local) as DirectCarrier;
    const controls: number[] = [];
    const barrier = new CarrierSwitchController({
      sendControl(_session, kind, payload) {
        if (kind === wsBorsh.KIND_CARRIER_SWITCH) {
          controls.push(decodeSwitch(payload).epoch);
        }
      },
      deliverInbound() {},
    });
    barrier.attachDirect(session, first);
    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(first);

    const replacement = createFakeCarrier() as DirectCarrier;
    barrier.attachDirect(session, replacement);
    expect(controls).toEqual([1, 2]);
    expect(session.activeCarrier).toBe(replacement);
    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(replacement);
    barrier.handleAck(session, 2);
    expect(session.activeCarrier).toBe(replacement);
  });

  test('sends CARRIER_SWITCH on the old carrier then immediately switches outbound to direct', () => {
    const session = createGatewaySession();
    const primary = session.primary as ReturnType<typeof createFakeCarrier>;
    const [local, remote] = pairDataChannels('sess');
    const direct = new DataChannelCarrier(local) as DirectCarrier;
    const peer = new DataChannelCarrier(remote);
    const outbound: string[] = [];
    const inbound: string[] = [];
    const activeAtSwitch: unknown[] = [];
    peer.onMessage((bytes) => {
      outbound.push(new TextDecoder().decode(bytes));
    });
    const barrier = new CarrierSwitchController({
      sendControl(_session, _kind, _payload) {
        activeAtSwitch.push(session.activeCarrier);
      },
      deliverInbound(_session, bytes) {
        inbound.push(new TextDecoder().decode(bytes));
      },
    });

    barrier.attachDirect(session, direct);
    expect(activeAtSwitch).toEqual([session.primary]);
    expect(session.activeCarrier).toBe(direct);

    expect(session.activeCarrier.send(new TextEncoder().encode('X'))).toBe('sent');
    expect(session.activeCarrier.send(new TextEncoder().encode('Y'))).toBe('sent');
    expect(outbound).toEqual(['X', 'Y']);
    expect(primary.sent).toEqual([]);

    expect(peer.send(new TextEncoder().encode('A'))).toBe('sent');
    expect(peer.send(new TextEncoder().encode('B'))).toBe('sent');
    expect(inbound).toEqual([]);

    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(direct);
    expect(inbound).toEqual(['A', 'B']);
    expect(outbound).toEqual(['X', 'Y']);
  });

  test('direct close switches back to primary and sends CARRIER_SWITCH to primary', () => {
    const session = createGatewaySession();
    const [local] = pairDataChannels('sess');
    const direct = new DataChannelCarrier(local) as DirectCarrier;
    const controls: Array<{ epoch: number; to: number }> = [];
    const barrier = new CarrierSwitchController({
      sendControl(_session, kind, payload) {
        if (kind === wsBorsh.KIND_CARRIER_SWITCH) controls.push(decodeSwitch(payload));
      },
      deliverInbound() {},
    });
    barrier.attachDirect(session, direct);
    barrier.handleAck(session, 1);
    expect(session.activeCarrier).toBe(direct);
    local.close();
    expect(session.activeCarrier).toBe(session.primary);
    expect(session.direct).toBeNull();
    expect(controls[1]).toEqual({ epoch: 2, to: wsBorsh.CARRIER_SWITCH_TO_PRIMARY });
  });
});
