import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import { openRelayStreamForPeer } from './peer-dialer-relay';
import { RelayDialBreaker } from './relay-dial-breaker';
import { RELAY_PRESENCE_STALE_MS, RelayPresence } from './relay-presence';
import { RelaySecondaryAttach, type RelaySecondaryRow } from './relay-secondary-attach';
import { waitUntil } from './test-support';
import type { MeshScheduler, UplinkState } from './types';

const PEER = 'ab'.repeat(16);
const SH = 'https://sh.example';
const TK = 'https://tk.example';

describe('relay path consolidate', () => {
  test('重启后的 boot 让更小的 list version 被接受', () => {
    const presence = new RelayPresence();
    presence.noteLink(SH, true, 10, 1_000);
    presence.applyList(SH, [{ id: PEER, online: true }], 5, 1_000, 'boot-a');
    presence.applyList(SH, [{ id: PEER, online: false }], 1, 2_000, 'boot-b');
    expect(presence.peersOnlineOn(SH)).toBe(0);
  });

  test('onlineUnion() 不会把已过期的 hold 当成永远在线', () => {
    const presence = new RelayPresence();
    presence.noteLink(SH, true, 10, 1_000);
    presence.applyList(SH, [{ id: PEER, online: true }], 1, 1_000);
    presence.markDisconnected(SH, 1_000, RELAY_PRESENCE_STALE_MS);
    expect(presence.onlineUnion().has(PEER)).toBe(false);
    expect(presence.onlineUnion(1_001).has(PEER)).toBe(true);
  });

  test('本机 uplink 离线不计入对端熔断', () => {
    const breaker = new RelayDialBreaker({ now: () => 1_000, jitter: 0, log: () => {} });
    expect(breaker.noteFailure(PEER, 'uplink is not online').counted).toBe(false);
    expect(breaker.noteFailure(PEER, 'offline').counted).toBe(true);
    breaker.reset();
    expect(breaker.noteFailure(PEER, 'offline').counted).toBe(true);
  });

  test('握手前失败会换下一条中继', async () => {
    const presence = new RelayPresence();
    presence.setPrimary(SH);
    presence.noteLink(SH, true, 10, 1);
    presence.noteLink(TK, true, 20, 1);
    presence.applyList(SH, [{ id: PEER, online: true }], 1, 1);
    presence.applyList(TK, [{ id: PEER, online: true }], 1, 1);
    const opened: string[] = [];
    const stream = { closed: new Promise(() => {}), reset() {} } as unknown as LinkStream;
    const result = await openRelayStreamForPeer({
      nodeId: PEER,
      presence,
      opener: {
        openRelayVia: async (url) => {
          opened.push(url);
          if (opened.length === 1) throw new Error('uplink is not online');
          return stream;
        },
      },
      openFallback: async () => {
        throw new Error('fallback');
      },
      breaker: new RelayDialBreaker({ log: () => {} }),
    });
    expect(opened.length).toBe(2);
    expect(opened[0]).not.toBe(opened[1]);
    expect(result.viaRelay).toBe(opened[1]);
  });

  test('旧主不再是 primary 后重新挂成 secondary', async () => {
    const scheduler = new ParkScheduler();
    let primary: string | null = SH;
    const spawned: string[] = [];
    const attach = new RelaySecondaryAttach({
      rows: () => [row(SH, 0), row(TK, 1)],
      primaryUrl: () => primary,
      spawn: (url) => {
        spawned.push(url);
        return new OnlineSecondary(url);
      },
      presence: new RelayPresence(),
      scheduler,
      openPrimary: async () => ({ id: 'p' }) as unknown as LinkStream,
    });
    attach.start();
    await attach.reconcile();
    await waitUntil(() => attach.client(TK)?.state === 'online');
    expect(spawned).toEqual([TK]);
    primary = TK;
    await attach.reconcile();
    await waitUntil(() => attach.client(SH)?.state === 'online');
    expect(attach.client(TK)).toBeNull();
    expect(attach.client(SH)?.state).toBe('online');
    await attach.stop();
  });
});

function row(url: string, priority: number): RelaySecondaryRow {
  return { url, priority, kicked: false, credentialKey: 'k' };
}

class ParkScheduler implements MeshScheduler {
  now(): number {
    return 1_000;
  }
  sleep(): Promise<void> {
    return new Promise(() => {});
  }
  interval(): { clear: () => void } {
    return { clear() {} };
  }
}

class OnlineSecondary {
  state: UplinkState = 'offline';
  rttMs: number | null = 8;
  quota = null;
  rtc = { stun: [] as string[], turn: null };
  nodesViaRelay = 0;
  awaitingToken = false;
  lastConnectError: { reason: string; at: number } | null = null;
  constructor(readonly uplinkUrl: string) {}
  start(): void {}
  async stop(): Promise<void> {
    this.state = 'offline';
  }
  async attemptConnect(): Promise<void> {
    this.state = 'online';
  }
  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  setOnRelayStream(): void {}
  sendStatus(): void {}
  sendCtl(): void {}
  async openRelay(): Promise<LinkStream> {
    return { id: this.uplinkUrl } as unknown as LinkStream;
  }
  onStateChange(cb: (state: UplinkState) => void): () => void {
    cb(this.state);
    return () => {};
  }
}
