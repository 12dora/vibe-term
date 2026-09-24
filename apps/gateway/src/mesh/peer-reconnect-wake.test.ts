import { describe, expect, test } from 'bun:test';
import {
  DC_PRESENCE_ABSENCE_MS,
  type LivePeer,
  PeerReconnectWake,
  RelayPresenceGap,
} from './peer-reconnect-wake';

function relayPeer(id: string, quiesceCapable: boolean): LivePeer {
  return { peerNodeId: id, transport: 'relay', quiesceCapable } as LivePeer;
}

describe('PeerReconnectWake', () => {
  test('a disabled relay flap still wakes, but that wake is not a presence return', () => {
    const wake = new PeerReconnectWake();
    const gap = new RelayPresenceGap();
    const peer = 'ec42f364';
    const woken: string[] = [];
    wake.lost(peer, true, false);
    const session = relayPeer(peer, false);
    wake.installed(session, (id) => woken.push(id));
    expect(woken).toEqual([]);
    expect(gap.observe(peer, true, 0)).toBe('unchanged');
    session.quiesceCapable = true;
    wake.ready(session, (id) => woken.push(id));
    expect(woken).toEqual([peer]);
    expect(gap.observe(peer, false, 1_000)).toBe('absent');
    expect(gap.observe(peer, true, 1_000 + DC_PRESENCE_ABSENCE_MS - 1)).toBe('unchanged');
  });

  test('absence longer than the presence stale window is a return', () => {
    const gap = new RelayPresenceGap();
    const peer = 'ec42f364';
    expect(gap.observe(peer, false, 10)).toBe('absent');
    expect(gap.observe(peer, false, 20)).toBe('absent');
    expect(gap.observe(peer, true, 10 + DC_PRESENCE_ABSENCE_MS)).toBe('returned');
    expect(gap.observe(peer, true, 10 + DC_PRESENCE_ABSENCE_MS + 1)).toBe('unchanged');
  });
});
