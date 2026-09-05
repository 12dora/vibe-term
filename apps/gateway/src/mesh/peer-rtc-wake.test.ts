import { describe, expect, test } from 'bun:test';
import type { RtcSignalMessage } from './mesh-deps';
import {
  RTC_SIGNAL_INBOX_TTL_MS,
  type RtcSignalInboxEntry,
  RtcWakeGate,
  type RtcWakePorts,
} from './peer-rtc-wake';

function setupReplay(entries: RtcSignalInboxEntry[]) {
  const peer = 'peer';
  const listeners = new Map<string, Set<(message: RtcSignalMessage) => void>>();
  const inbox = new Map([[peer, entries]]);
  const gate = new RtcWakeGate({
    scheduler: { now: () => 100_000 },
    rtcListeners: () => listeners,
    rtcInbox: () => inbox,
  } as unknown as RtcWakePorts);
  return { gate, inbox, listeners, peer };
}

describe('RtcWakeGate signaling inbox', () => {
  test('returns unsubscribe before replay and drops entries older than 30 seconds', async () => {
    const message = (to: string): RtcSignalMessage => ({
      rtcSession: 'dc:a:b',
      from: 'node',
      to,
      sdp: '{"type":"offer","sdp":"v=0"}',
    });
    const { gate, inbox, listeners, peer } = setupReplay([
      { message: message('expired'), receivedAt: 100_000 - RTC_SIGNAL_INBOX_TTL_MS - 1 },
      { message: message('fresh'), receivedAt: 100_000 - RTC_SIGNAL_INBOX_TTL_MS },
    ]);
    const seen: string[] = [];
    const unsubscribe = gate.signalingFor(peer).onMessage((signal) => seen.push(signal.to));

    expect(typeof unsubscribe).toBe('function');
    expect(listeners.get(peer)?.size).toBe(1);
    expect(inbox.has(peer)).toBe(false);
    await Promise.resolve();
    expect(seen).toEqual(['fresh']);
    unsubscribe();
    expect(listeners.has(peer)).toBe(false);
  });

  test('unsubscribe before the replay microtask prevents delivery', async () => {
    const queued: RtcSignalMessage = {
      rtcSession: 'dc:a:b',
      from: 'node',
      to: 'self',
      candidate: '{"candidate":"candidate:1","mid":"0"}',
    };
    const { gate, listeners, peer } = setupReplay([{ message: queued, receivedAt: 100_000 }]);
    let deliveries = 0;
    const unsubscribe = gate.signalingFor(peer).onMessage(() => {
      deliveries += 1;
    });
    unsubscribe();
    await Promise.resolve();
    expect(deliveries).toBe(0);
    expect(listeners.has(peer)).toBe(false);
  });
});
