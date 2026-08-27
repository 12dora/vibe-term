import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url, generateEd25519KeyPair, randomBytes } from '@tmex/shared/auth';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import { enumeratePeerEndpoints } from '../mesh-runtime';
import { ImmediateScheduler, seedUser, waitUntil } from '../test-support';
import type { KeyLogApplier } from '../types';
import { UplinkClient } from '../uplink-client';
import { encodeUplinkCtl } from '../uplink-protocol';

describe('enumeratePeerEndpoints', () => {
  test('advertises non-internal IPv4 and IPv6 and skips loopback', () => {
    const urls = enumeratePeerEndpoints(39001, {
      lo0: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
        {
          address: '::1',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '::1/128',
          scopeid: 0,
        },
      ],
      en0: [
        {
          address: '10.0.0.12',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '10.0.0.12/24',
        },
        {
          address: '2001:db8::8',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '2001:db8::8/64',
          scopeid: 0,
        },
        {
          address: 'fe80::1%en0',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 4,
        },
      ],
    });
    expect(urls).toEqual(['ws://10.0.0.12:39001/peer', 'ws://[2001:db8::8]:39001/peer']);
  });

  test('treats numeric family 4/6 the same as IPv4/IPv6', () => {
    const urls = enumeratePeerEndpoints(9, {
      eth0: [
        {
          address: '192.0.2.10',
          netmask: '255.255.255.0',
          family: 4 as unknown as 'IPv4',
          mac: '',
          internal: false,
          cidr: '192.0.2.10/24',
        },
      ],
    });
    expect(urls).toEqual(['ws://192.0.2.10:9/peer']);
  });

  test('skips IPv4 link-local, unspecified, multicast and IPv6 link-local without zone id', () => {
    const urls = enumeratePeerEndpoints(39001, {
      en0: [
        {
          address: '169.254.10.20',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: '169.254.10.20/16',
        },
        {
          address: '0.0.0.0',
          netmask: '0.0.0.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: '0.0.0.0/0',
        },
        {
          address: '224.0.0.1',
          netmask: '240.0.0.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: '224.0.0.1/4',
        },
        {
          address: 'fe80::aabb',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '',
          internal: false,
          cidr: 'fe80::aabb/64',
          scopeid: 0,
        },
        {
          address: 'ff02::1',
          netmask: 'ffff::',
          family: 'IPv6',
          mac: '',
          internal: false,
          cidr: 'ff02::1/16',
          scopeid: 0,
        },
        {
          address: '::',
          netmask: '::',
          family: 'IPv6',
          mac: '',
          internal: false,
          cidr: '::/0',
          scopeid: 0,
        },
        {
          address: '192.0.2.8',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '',
          internal: false,
          cidr: '192.0.2.8/24',
        },
      ],
    });
    expect(urls).toEqual(['ws://192.0.2.8:39001/peer']);
  });
});

describe('UplinkClient.connectWithLink', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('authenticates over an in-memory pair without private-member casts', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const userStore = new UserStore(db);
    seedUser(userStore);
    const applier: KeyLogApplier = {
      async head() {
        return { seq: 0n, hash: new Uint8Array(32) };
      },
      async applyMany() {
        return { applied: 0 };
      },
    };
    const [nodeLink, hubLink] = createInMemoryLinkPair();
    const received: string[] = [];
    hubLink.ctl.onMessage((bytes) => {
      received.push(new TextDecoder().decode(bytes));
    });
    const keys = generateEd25519KeyPair();
    const client = new UplinkClient({
      hubUrl: 'https://hub.example.com',
      identity: { nodeId: 'ab'.repeat(16), edSecretKey: keys.secretKey },
      userId: 'user-1',
      keyLogApplier: applier,
      userStore,
      statusProvider: () => ({
        version: '1',
        tmux: false,
        direct_capable: false,
        inventory: {},
        endpoints: [],
      }),
      scheduler: new ImmediateScheduler(),
      pingIntervalMs: 60_000,
    });
    fixtures.push({ close, stop: () => client.stop() });

    const connecting = client.connectWithLink(nodeLink);
    hubLink.ctl.send(
      encodeUplinkCtl({ t: 'auth.challenge', nonce: encodeBase64url(randomBytes(32)) })
    );
    await waitUntil(() => received.some((row) => row.includes('auth.response')));
    hubLink.ctl.send(encodeUplinkCtl({ t: 'auth.ok' }));
    await connecting;
    expect(client.state).toBe('online');
    expect(client.link).toBe(nodeLink);
  });
});
