import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { PeerManager } from './peer-manager';
import { dummyUplink } from './peer-test-fixtures';
import { seedNodeIdentity, seedUser } from './test-support';

describe('PeerManager inbound relay viaRelay', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('acceptInboundRelay 把 viaRelay 传给 dialer.acceptRelay', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const self = seedNodeIdentity(store, 'user-1');
    const uplink = dummyUplink(self, store);
    const captured: {
      fn: ((stream: LinkStream, from: string, viaRelay?: string) => void) | null;
    } = { fn: null };
    const orig = uplink.setOnRelayStream.bind(uplink);
    uplink.setOnRelayStream = (handler) => {
      captured.fn = handler;
      orig(handler);
    };
    const manager = new PeerManager({
      identity: self,
      userStore: store,
      uplink,
      peerPort: 0,
      startServer: false,
    });
    fixtures.push({ close, stop: () => manager.stop() });
    const seen: Array<{ from: string; viaRelay?: string }> = [];
    const dialer = (
      manager as unknown as {
        dialer: {
          acceptRelay: (stream: LinkStream, from: string, viaRelay?: string) => Promise<void>;
        };
      }
    ).dialer;
    dialer.acceptRelay = async (_stream, from, viaRelay) => {
      seen.push({ from, viaRelay });
    };
    const stream = { closed: Promise.resolve() } as unknown as LinkStream;
    const from = 'ab'.repeat(16);
    manager.acceptInboundRelay(stream, from, 'https://tk.example');
    captured.fn?.(stream, from, 'https://sh.example');
    await Promise.resolve();
    expect(seen).toEqual([
      { from, viaRelay: 'https://tk.example' },
      { from, viaRelay: 'https://sh.example' },
    ]);
  });
});
