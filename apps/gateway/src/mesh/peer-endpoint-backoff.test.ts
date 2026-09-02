import { describe, expect, test } from 'bun:test';
import {
  ENDPOINT_BACKOFF_CAP_MS,
  ENDPOINT_BACKOFF_IDLE_MS,
  ENDPOINT_BACKOFF_MIN_MS,
  PeerEndpointBackoff,
  canonicalEndpointSet,
  parsePeerEndpoint,
} from './peer-endpoint-backoff';

describe('PeerEndpointBackoff', () => {
  test('parsePeerEndpoint canonicalizes host and port', () => {
    expect(parsePeerEndpoint('ws://10.0.0.1:39001/peer')).toEqual({
      host: '10.0.0.1',
      port: 39001,
    });
    expect(parsePeerEndpoint('ws://[::ffff:10.0.0.1]:39001/peer')).toEqual({
      host: '10.0.0.1',
      port: 39001,
    });
    expect(parsePeerEndpoint('wss://example.test/peer')).toEqual({
      host: 'example.test',
      port: 443,
    });
    expect(
      canonicalEndpointSet([
        'ws://10.0.0.2:1/peer',
        'ws://10.0.0.1:1/peer',
        'ws://[::ffff:10.0.0.1]:1/x',
      ])
    ).toBe('10.0.0.1|1\n10.0.0.2|1');
  });

  test('exponential backoff 1m→2m→4m capped at 6h, protocol failures are ignored', () => {
    let now = 1_000_000;
    const logs: string[] = [];
    const backoff = new PeerEndpointBackoff({
      now: () => now,
      log: (msg) => logs.push(msg),
    });
    const node = 'aa'.repeat(16);
    const url = 'ws://10.0.0.9:39001/peer';
    expect(backoff.eligible(node, url, now)).toBe(true);
    expect(backoff.noteFailure(node, url, 'protocol')).toBeNull();
    expect(backoff.eligible(node, url, now)).toBe(true);

    backoff.noteFailure(node, url, 'refused', now);
    expect(backoff.eligible(node, url, now)).toBe(false);
    expect(backoff.nextEligibleAt(node, url)).toBe(now + ENDPOINT_BACKOFF_MIN_MS);
    now += ENDPOINT_BACKOFF_MIN_MS - 1;
    expect(backoff.eligible(node, url, now)).toBe(false);
    now += 1;
    expect(backoff.eligible(node, url, now)).toBe(true);

    backoff.noteFailure(node, url, 'timeout', now);
    expect(backoff.nextEligibleAt(node, url)).toBe(now + 2 * ENDPOINT_BACKOFF_MIN_MS);
    backoff.noteFailure(node, url, 'open-timeout', now);
    expect(backoff.nextEligibleAt(node, url)).toBe(now + 4 * ENDPOINT_BACKOFF_MIN_MS);

    for (let i = 0; i < 20; i++) backoff.noteFailure(node, url, 'unreachable', now);
    expect((backoff.nextEligibleAt(node, url) ?? 0) - now).toBe(ENDPOINT_BACKOFF_CAP_MS);

    expect(logs.some((line) => line.includes('fails=1') && line.includes('endpoint backoff'))).toBe(
      true
    );
    expect(logs.some((line) => line.includes('fails=3'))).toBe(true);
    expect(logs.some((line) => line.includes('fails=6'))).toBe(true);
    expect(logs.some((line) => line.includes('fails=12'))).toBe(true);
    expect(logs.filter((line) => line.includes('fails=2')).length).toBe(0);
  });

  test('success after failures logs recovered and clears the address', () => {
    let now = 5_000;
    const logs: string[] = [];
    const backoff = new PeerEndpointBackoff({
      now: () => now,
      log: (msg) => logs.push(msg),
    });
    const node = 'bb'.repeat(16);
    const url = 'ws://192.168.1.8:9/peer';
    backoff.noteFailure(node, url, 'reset', now);
    expect(backoff.size()).toBe(1);
    now += 10;
    backoff.noteSuccess(node, url, now);
    expect(backoff.size()).toBe(0);
    expect(backoff.eligible(node, url, now)).toBe(true);
    expect(logs.some((line) => line.startsWith('endpoint recovered'))).toBe(true);
  });

  test('resetNode / resetAll / prune idle > 24h', () => {
    let now = 10_000;
    const backoff = new PeerEndpointBackoff({ now: () => now });
    const a = '11'.repeat(16);
    const b = '22'.repeat(16);
    backoff.noteFailure(a, 'ws://10.0.0.1:1/peer', 'refused', now);
    backoff.noteFailure(b, 'ws://10.0.0.2:1/peer', 'refused', now);
    expect(backoff.size()).toBe(2);
    backoff.resetNode(a);
    expect(backoff.size()).toBe(1);
    expect(backoff.eligible(a, 'ws://10.0.0.1:1/peer', now)).toBe(true);
    backoff.resetAll();
    expect(backoff.size()).toBe(0);

    backoff.noteFailure(b, 'ws://10.0.0.2:1/peer', 'refused', now);
    now += ENDPOINT_BACKOFF_IDLE_MS + 1;
    expect(backoff.eligible(b, 'ws://10.0.0.2:1/peer', now)).toBe(true);
    expect(backoff.size()).toBe(0);
  });

  test('minWaitMs reports the soonest remaining backoff', () => {
    const now = 1_000;
    const backoff = new PeerEndpointBackoff({ now: () => now });
    const node = 'cc'.repeat(16);
    backoff.noteFailure(node, 'ws://10.0.0.1:1/peer', 'refused', now);
    const later = now + 5_000;
    backoff.noteFailure(node, 'ws://10.0.0.2:1/peer', 'refused', later);
    expect(backoff.minWaitMs(node, ['ws://10.0.0.1:1/peer', 'ws://10.0.0.2:1/peer'], later)).toBe(
      ENDPOINT_BACKOFF_MIN_MS - 5_000
    );
  });
});
