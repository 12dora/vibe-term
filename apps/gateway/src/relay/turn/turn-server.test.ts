import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { DEFAULT_DENIED_PEER_CIDRS } from './denied-peers';
import { type TurnServer, type TurnServerOptions, createTurnServer, turnUrlFor } from './index';
import {
  ATTR,
  CLASS,
  METHOD,
  type StunAttribute,
  type StunMessage,
  addressAttribute,
  channelNumberAttribute,
  decodeAddress,
  decodeChannelData,
  decodeErrorCode,
  decodeMessage,
  encodeChannelData,
  encodeMessage,
  getAttribute,
  isChannelData,
  longTermKey,
  requestedTransportAttribute,
  textAttribute,
  uint32Attribute,
  verifyFingerprint,
  verifyIntegrity,
} from './stun-message';
import type { TurnContext } from './turn-context';
import {
  MAX_PERMISSIONS_PER_ALLOCATION,
  MAX_XOR_PEERS_PER_REQUEST,
  UNAUTH_PER_IP_BURST,
} from './turn-limits';
import { closeSocket, listenUdp } from './turn-udp';

const USER = 'alice';
const PASS = 'secret';
const REALM = 'vibeterm';
const KEY = longTermKey(USER, REALM, PASS);

type Packet = { msg: Buffer; rinfo: dgram.RemoteInfo };

class PacketInbox {
  private readonly queued: Packet[] = [];
  private readonly waiters: Array<(packet: Packet) => void> = [];

  constructor(socket: dgram.Socket) {
    socket.on('message', (msg, rinfo) => {
      const packet = { msg, rinfo };
      const waiter = this.waiters.shift();
      if (waiter) waiter(packet);
      else this.queued.push(packet);
    });
  }

  take(timeoutMs = 1500): Promise<Packet> {
    const next = this.queued.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onPacket);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('udp timeout'));
      }, timeoutMs);
      const onPacket = (packet: Packet): void => {
        clearTimeout(timer);
        resolve(packet);
      };
      this.waiters.push(onPacket);
    });
  }
}

type UdpClient = {
  socket: dgram.Socket;
  inbox: PacketInbox;
  address: string;
  port: number;
  send: (buf: Buffer, port: number) => void;
  close: () => Promise<void>;
};

type Harness = {
  server: TurnServer;
  port: number;
  advance: (ms: number) => void;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function openClient(): Promise<UdpClient> {
  const socket = dgram.createSocket('udp4');
  const inbox = new PacketInbox(socket);
  await listenUdp(socket, 0, '127.0.0.1');
  const addr = socket.address();
  const client: UdpClient = {
    socket,
    inbox,
    address: addr.address,
    port: addr.port,
    send: (buf, port) => {
      socket.send(buf, port, '127.0.0.1');
    },
    close: () => closeSocket(socket),
  };
  cleanups.push(client.close);
  return client;
}

async function boot(overrides: Partial<TurnServerOptions> = {}): Promise<Harness> {
  let now = 1_000_000;
  const begin = 22000 + Math.floor(Math.random() * 20000);
  const server = createTurnServer({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayPortRange: { begin, end: begin + 24 },
    externalIp: '127.0.0.1',
    realm: REALM,
    credentials: (user) => (user === USER ? PASS : null),
    deniedPeerCidrs: [],
    ...overrides,
    now: overrides.now ?? (() => now),
  });
  cleanups.push(() => server.stop());
  const { port } = await server.start();
  return {
    server,
    port,
    advance: (ms) => {
      now += ms;
    },
  };
}

function errorCodeOf(msg: StunMessage): number | undefined {
  const value = getAttribute(msg, ATTR.ERROR_CODE);
  return value ? decodeErrorCode(value)?.code : undefined;
}

function nonceOf(msg: StunMessage): string {
  return getAttribute(msg, ATTR.NONCE)?.toString('utf8') ?? '';
}

function lifetimeOf(msg: StunMessage): number | undefined {
  const value = getAttribute(msg, ATTR.LIFETIME);
  return value && value.length >= 4 ? value.readUInt32BE(0) : undefined;
}

async function recvStun(inbox: PacketInbox): Promise<StunMessage> {
  const { msg } = await inbox.take();
  const decoded = decodeMessage(msg);
  if (!decoded) throw new Error('expected STUN');
  return decoded;
}

function authed(
  method: number,
  nonce: string,
  attrs: readonly StunAttribute[] = [],
  tx: Buffer = randomBytes(12)
): Buffer {
  return encodeMessage({
    method,
    class: CLASS.REQUEST,
    transactionId: tx,
    attributes: [
      textAttribute(ATTR.USERNAME, USER),
      textAttribute(ATTR.REALM, REALM),
      textAttribute(ATTR.NONCE, nonce),
      ...attrs,
    ],
    integrityKey: KEY,
    fingerprint: true,
  });
}

async function challengeNonce(client: UdpClient, port: number): Promise<string> {
  client.send(
    encodeMessage({
      method: METHOD.ALLOCATE,
      class: CLASS.REQUEST,
      attributes: [requestedTransportAttribute()],
      fingerprint: true,
    }),
    port
  );
  const challenge = await recvStun(client.inbox);
  expect(errorCodeOf(challenge)).toBe(401);
  expect(verifyFingerprint(challenge)).toBe(true);
  expect(getAttribute(challenge, ATTR.MESSAGE_INTEGRITY)).toBeUndefined();
  const nonce = nonceOf(challenge);
  expect(nonce.length).toBeGreaterThan(8);
  return nonce;
}

async function allocate(
  client: UdpClient,
  port: number,
  extra: readonly StunAttribute[] = []
): Promise<{ msg: StunMessage; nonce: string }> {
  const nonce = await challengeNonce(client, port);
  client.send(authed(METHOD.ALLOCATE, nonce, [requestedTransportAttribute(), ...extra]), port);
  const msg = await recvStun(client.inbox);
  return { msg, nonce };
}

describe('turnUrlFor', () => {
  test('brackets IPv6 hosts', () => {
    expect(turnUrlFor('example.com', 3478)).toBe('turn:example.com:3478?transport=udp');
    expect(turnUrlFor('::1', 3478)).toBe('turn:[::1]:3478?transport=udp');
    expect(turnUrlFor('[2001:db8::1]', 3478)).toBe('turn:[2001:db8::1]:3478?transport=udp');
  });
});

describe('TURN server lifecycle', () => {
  test('start() rejects when the UDP port is busy', async () => {
    const blocker = dgram.createSocket('udp4');
    cleanups.push(() => closeSocket(blocker));
    await listenUdp(blocker, 0, '127.0.0.1');
    const busy = blocker.address().port;
    const server = createTurnServer({
      listenHost: '127.0.0.1',
      listenPort: busy,
      relayPortRange: { begin: busy + 1, end: busy + 2 },
      externalIp: '127.0.0.1',
      realm: REALM,
      credentials: () => PASS,
    });
    await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  test('stop() closes every relay socket and is idempotent', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const { msg } = await allocate(client, port);
    expect(msg.class).toBe(CLASS.SUCCESS);
    const relayed = decodeAddress(
      getAttribute(msg, ATTR.XOR_RELAYED_ADDRESS) ?? Buffer.alloc(0),
      msg.transactionId
    );
    expect(relayed).toBeDefined();
    if (!relayed) throw new Error('missing XOR-RELAYED-ADDRESS');
    expect(relayed.port).toBeGreaterThan(0);
    await server.stop();
    expect(server.snapshot().allocations).toBe(0);
    await server.stop();
    const probe = dgram.createSocket('udp4');
    cleanups.push(() => closeSocket(probe));
    await listenUdp(probe, relayed.port, '127.0.0.1');
    expect(probe.address().port).toBe(relayed.port);
  });
});

describe('STUN Binding and Allocate', () => {
  test('unauthenticated Binding returns XOR-MAPPED-ADDRESS with fingerprint', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    client.send(
      encodeMessage({
        method: METHOD.BINDING,
        class: CLASS.REQUEST,
        fingerprint: true,
      }),
      port
    );
    const msg = await recvStun(client.inbox);
    expect(msg.class).toBe(CLASS.SUCCESS);
    expect(verifyFingerprint(msg)).toBe(true);
    const mapped = decodeAddress(
      getAttribute(msg, ATTR.XOR_MAPPED_ADDRESS) ?? Buffer.alloc(0),
      msg.transactionId
    );
    expect(mapped).toEqual({ address: '127.0.0.1', port: client.port });
    expect(server.snapshot().bindingRequests).toBe(1);
    expect(server.snapshot().bindHost).toBe('127.0.0.1');
  });

  test('Binding reply is sourced from the bound listen host', async () => {
    const { server, port } = await boot({ listenHost: '127.0.0.1' });
    const client = await openClient();
    client.send(
      encodeMessage({
        method: METHOD.BINDING,
        class: CLASS.REQUEST,
        fingerprint: true,
      }),
      port
    );
    const packet = await client.inbox.take();
    expect(packet.rinfo.address).toBe('127.0.0.1');
    const msg = decodeMessage(packet.msg);
    expect(msg?.class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().bindHost).toBe('127.0.0.1');
  });

  test('EADDRNOTAVAIL at bind time falls back to 0.0.0.0', async () => {
    const logs: string[] = [];
    const { server, port } = await boot({
      listenHost: '203.0.113.99',
      log: (line) => logs.push(line),
    });
    expect(server.snapshot().bindHost).toBe('0.0.0.0');
    expect(logs.some((line) => line.includes('EADDRNOTAVAIL'))).toBe(true);
    const client = await openClient();
    client.send(
      encodeMessage({
        method: METHOD.BINDING,
        class: CLASS.REQUEST,
        fingerprint: true,
      }),
      port
    );
    const msg = await recvStun(client.inbox);
    expect(msg.class).toBe(CLASS.SUCCESS);
  });

  test('setExternalIp changes XOR-RELAYED-ADDRESS without dropping allocations', async () => {
    const begin = 32000 + Math.floor(Math.random() * 10000);
    const { server, port } = await boot({
      externalIp: '198.51.100.1',
      relayPortRange: { begin, end: begin + 15 },
    });
    const first = await openClient();
    const { msg: firstMsg, nonce } = await allocate(first, port);
    const firstRelayed = decodeAddress(
      getAttribute(firstMsg, ATTR.XOR_RELAYED_ADDRESS) ?? Buffer.alloc(0),
      firstMsg.transactionId
    );
    expect(firstRelayed?.address).toBe('198.51.100.1');
    const listenPort = server.snapshot().port;
    expect(server.snapshot().allocations).toBe(1);

    server.setExternalIp('203.0.113.9');
    expect(server.snapshot()).toMatchObject({
      externalIp: '203.0.113.9',
      listening: true,
      port: listenPort,
      allocations: 1,
    });

    first.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 600)]), port);
    expect((await recvStun(first.inbox)).class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().allocations).toBe(1);

    const second = await openClient();
    const { msg: secondMsg } = await allocate(second, port);
    const secondRelayed = decodeAddress(
      getAttribute(secondMsg, ATTR.XOR_RELAYED_ADDRESS) ?? Buffer.alloc(0),
      secondMsg.transactionId
    );
    expect(secondRelayed?.address).toBe('203.0.113.9');
    expect(secondRelayed?.port).not.toBe(firstRelayed?.port);
    expect(server.snapshot()).toMatchObject({
      allocations: 2,
      listening: true,
      port: listenPort,
      externalIp: '203.0.113.9',
    });
  });

  test('401 then authenticated Allocate with relayed address in range', async () => {
    const begin = 31000 + Math.floor(Math.random() * 10000);
    const { port } = await boot({ relayPortRange: { begin, end: begin + 15 } });
    const client = await openClient();
    const { msg } = await allocate(client, port, [uint32Attribute(ATTR.LIFETIME, 60)]);
    expect(msg.class).toBe(CLASS.SUCCESS);
    expect(verifyFingerprint(msg)).toBe(true);
    expect(verifyIntegrity(msg, KEY)).toBe(true);
    expect(lifetimeOf(msg)).toBe(600);
    const relayed = decodeAddress(
      getAttribute(msg, ATTR.XOR_RELAYED_ADDRESS) ?? Buffer.alloc(0),
      msg.transactionId
    );
    expect(relayed?.address).toBe('127.0.0.1');
    expect(relayed?.port).toBeGreaterThanOrEqual(begin);
    expect(relayed?.port).toBeLessThanOrEqual(begin + 15);
  });

  test('clamps requested lifetime to maxLifetimeSec', async () => {
    const { port } = await boot({ maxLifetimeSec: 900 });
    const client = await openClient();
    const { msg } = await allocate(client, port, [uint32Attribute(ATTR.LIFETIME, 10_000)]);
    expect(lifetimeOf(msg)).toBe(900);
  });

  test('unknown user does not leak and unknown method is 400', async () => {
    const { port } = await boot();
    const client = await openClient();
    const nonce = await challengeNonce(client, port);
    const badKey = longTermKey('eve', REALM, PASS);
    client.send(
      encodeMessage({
        method: METHOD.ALLOCATE,
        class: CLASS.REQUEST,
        attributes: [
          textAttribute(ATTR.USERNAME, 'eve'),
          textAttribute(ATTR.REALM, REALM),
          textAttribute(ATTR.NONCE, nonce),
          requestedTransportAttribute(),
        ],
        integrityKey: badKey,
        fingerprint: true,
      }),
      port
    );
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(401);
    client.send(authed(0x0a, nonce, [requestedTransportAttribute()]), port);
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(400);
  });
});

describe('TURN error codes', () => {
  test('437 on a second Allocate from the same 5-tuple', async () => {
    const { port } = await boot();
    const client = await openClient();
    const { msg, nonce } = await allocate(client, port);
    expect(msg.class).toBe(CLASS.SUCCESS);
    client.send(authed(METHOD.ALLOCATE, nonce, [requestedTransportAttribute()]), port);
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(437);
  });

  test('442 for non-UDP REQUESTED-TRANSPORT and 400 for EVEN-PORT', async () => {
    const { port } = await boot();
    const client = await openClient();
    const nonce = await challengeNonce(client, port);
    client.send(authed(METHOD.ALLOCATE, nonce, [requestedTransportAttribute(6)]), port);
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(442);
    client.send(
      authed(METHOD.ALLOCATE, nonce, [
        requestedTransportAttribute(),
        { type: ATTR.EVEN_PORT, value: Buffer.from([0x80]) },
      ]),
      port
    );
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(400);
  });

  test('486 when allocation quota is exceeded', async () => {
    const { port } = await boot({ maxAllocations: 1 });
    const a = await openClient();
    const b = await openClient();
    expect((await allocate(a, port)).msg.class).toBe(CLASS.SUCCESS);
    expect(errorCodeOf((await allocate(b, port)).msg)).toBe(486);
  });

  test('508 when the relay port range is exhausted', async () => {
    const holder = dgram.createSocket('udp4');
    cleanups.push(() => closeSocket(holder));
    await listenUdp(holder, 0, '127.0.0.1');
    const only = holder.address().port;
    await closeSocket(holder);
    const { port } = await boot({
      relayPortRange: { begin: only, end: only },
      maxAllocations: 8,
      maxAllocationsPerUser: 8,
    });
    const a = await openClient();
    const b = await openClient();
    expect((await allocate(a, port)).msg.class).toBe(CLASS.SUCCESS);
    expect(errorCodeOf((await allocate(b, port)).msg)).toBe(508);
  });

  test('403 for a denied peer and for the server listen port', async () => {
    const { port } = await boot({ deniedPeerCidrs: DEFAULT_DENIED_PEER_CIDRS });
    const client = await openClient();
    const { msg, nonce } = await allocate(client, port);
    expect(msg.class).toBe(CLASS.SUCCESS);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CREATE_PERMISSION,
        nonce,
        [addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: '10.1.2.3', port: 9 }, tx)],
        tx
      ),
      port
    );
    const denied = await recvStun(client.inbox);
    expect(errorCodeOf(denied)).toBe(403);
    expect(verifyIntegrity(denied, KEY)).toBe(true);
  });

  test('403 when CreatePermission targets the TURN listen port', async () => {
    const { port } = await boot();
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CREATE_PERMISSION,
        nonce,
        [addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: '127.0.0.1', port }, tx)],
        tx
      ),
      port
    );
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(403);
  });
});

describe('permission, Send/Data, ChannelData', () => {
  test('CreatePermission + Send indication + Data indication both ways', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { msg, nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CREATE_PERMISSION,
        nonce,
        [addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx)],
        tx
      ),
      port
    );
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    const payload = Buffer.from('hello-peer');
    const sendTx = randomBytes(12);
    client.send(
      encodeMessage({
        method: METHOD.SEND,
        class: CLASS.INDICATION,
        transactionId: sendTx,
        attributes: [
          addressAttribute(
            ATTR.XOR_PEER_ADDRESS,
            { address: peer.address, port: peer.port },
            sendTx
          ),
          { type: ATTR.DATA, value: payload },
        ],
        fingerprint: true,
      }),
      port
    );
    const incoming = await peer.inbox.take();
    expect(incoming.msg.equals(payload)).toBe(true);
    const reply = Buffer.from('from-peer');
    peer.socket.send(reply, incoming.rinfo.port, incoming.rinfo.address);
    const dataInd = await recvStun(client.inbox);
    expect(dataInd.method).toBe(METHOD.DATA);
    expect(dataInd.class).toBe(CLASS.INDICATION);
    expect(getAttribute(dataInd, ATTR.DATA)?.equals(reply)).toBe(true);
    expect(server.snapshot().bytesRelayedOut).toBeGreaterThan(0);
    expect(server.snapshot().bytesRelayedIn).toBeGreaterThan(0);
  });

  test('ChannelBind + ChannelData both ways', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CHANNEL_BIND,
        nonce,
        [
          addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx),
          channelNumberAttribute(0x4005),
        ],
        tx
      ),
      port
    );
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().channels).toBe(1);
    client.send(encodeChannelData(0x4005, Buffer.from('c2p')), port);
    const toPeer = await peer.inbox.take();
    expect(toPeer.msg.equals(Buffer.from('c2p'))).toBe(true);
    peer.socket.send(Buffer.from('p2c'), toPeer.rinfo.port, toPeer.rinfo.address);
    const back = await client.inbox.take();
    expect(isChannelData(back.msg)).toBe(true);
    expect(decodeChannelData(back.msg)).toEqual({
      channel: 0x4005,
      data: Buffer.from('p2c'),
    });
  });

  test('Refresh(0) releases the allocation', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    expect(server.snapshot().allocations).toBe(1);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 0)]), port);
    const freed = await recvStun(client.inbox);
    expect(freed.class).toBe(CLASS.SUCCESS);
    expect(lifetimeOf(freed)).toBe(0);
    expect(server.snapshot().allocations).toBe(0);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 600)]), port);
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(437);
  });
});

describe('nonce rotation, expiry, rate limit, garbage', () => {
  test('stale nonce 438 after the injected clock advances past grace', async () => {
    const { port, advance } = await boot({ maxLifetimeSec: 10_000 });
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 10_000)]), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    advance(3_901_000);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 600)]), port);
    const stale = await recvStun(client.inbox);
    expect(errorCodeOf(stale)).toBe(438);
    expect(nonceOf(stale)).not.toBe(nonce);
    expect(verifyFingerprint(stale)).toBe(true);
  });

  test('previous nonce remains valid for 5 minutes after rotation', async () => {
    const { port, advance } = await boot({ maxLifetimeSec: 10_000 });
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 10_000)]), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    advance(3_601_000);
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 600)]), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
  });

  test('allocation, permission and channel expire via the injected clock', async () => {
    const { server, port, advance } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CHANNEL_BIND,
        nonce,
        [
          addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx),
          channelNumberAttribute(0x4000),
        ],
        tx
      ),
      port
    );
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    advance(301_000);
    expect(server.snapshot().permissions).toBe(0);
    expect(server.snapshot().allocations).toBe(1);
    client.send(encodeChannelData(0x4000, Buffer.from('late')), port);
    await expect(peer.inbox.take(200)).rejects.toThrow('udp timeout');
    client.send(authed(METHOD.REFRESH, nonce, [uint32Attribute(ATTR.LIFETIME, 3600)]), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    advance(301_000);
    expect(server.snapshot().channels).toBe(0);
    expect(server.snapshot().allocations).toBe(1);
    advance(3_600_000);
    expect(server.snapshot().allocations).toBe(0);
  });

  test('per-allocation rate limit drops excess bytes', async () => {
    const { server, port } = await boot({ bytesPerSecPerAllocation: 8 });
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CREATE_PERMISSION,
        nonce,
        [addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx)],
        tx
      ),
      port
    );
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    const sendTx = randomBytes(12);
    client.send(
      encodeMessage({
        method: METHOD.SEND,
        class: CLASS.INDICATION,
        transactionId: sendTx,
        attributes: [
          addressAttribute(
            ATTR.XOR_PEER_ADDRESS,
            { address: peer.address, port: peer.port },
            sendTx
          ),
          { type: ATTR.DATA, value: Buffer.alloc(32, 7) },
        ],
        fingerprint: true,
      }),
      port
    );
    await expect(peer.inbox.take(200)).rejects.toThrow('udp timeout');
    expect(server.snapshot().droppedRateLimit ?? 0).toBeGreaterThan(0);
  });

  test('garbage datagrams are dropped and the socket stays alive', async () => {
    const { port } = await boot();
    const client = await openClient();
    for (let i = 0; i < 40; i++) client.send(randomBytes(20 + (i % 80)), port);
    client.send(
      encodeMessage({
        method: METHOD.BINDING,
        class: CLASS.REQUEST,
        fingerprint: true,
      }),
      port
    );
    const msg = await recvStun(client.inbox);
    expect(msg.class).toBe(CLASS.SUCCESS);
    expect(verifyFingerprint(msg)).toBe(true);
  });
});

function serverCtx(server: TurnServer): TurnContext {
  return (server as unknown as { ctx: TurnContext }).ctx;
}

function bindingRequest(): Buffer {
  return encodeMessage({
    method: METHOD.BINDING,
    class: CLASS.REQUEST,
    fingerprint: true,
  });
}

async function permitPeers(
  client: UdpClient,
  port: number,
  nonce: string,
  peers: Array<{ address: string; port: number }>
): Promise<StunMessage> {
  const tx = randomBytes(12);
  client.send(
    authed(
      METHOD.CREATE_PERMISSION,
      nonce,
      peers.map((peer) => addressAttribute(ATTR.XOR_PEER_ADDRESS, peer, tx)),
      tx
    ),
    port
  );
  return recvStun(client.inbox);
}

describe('oversized peer datagrams', () => {
  test('65507-byte datagram without a channel is dropped; Binding still answers', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    expect((await permitPeers(client, port, nonce, [peer])).class).toBe(CLASS.SUCCESS);
    const allocation = serverCtx(server).table.getByClient({
      address: client.address,
      port: client.port,
    });
    expect(allocation).toBeDefined();
    allocation?.socket.emit('message', Buffer.alloc(65_507, 3), {
      address: peer.address,
      family: 'IPv4',
      port: peer.port,
      size: 65_507,
    });
    expect(server.snapshot().droppedOversized).toBe(1);
    expect(server.snapshot().bytesRelayedIn).toBe(0);
    client.send(bindingRequest(), port);
    const msg = await recvStun(client.inbox);
    expect(msg.class).toBe(CLASS.SUCCESS);
    expect(verifyFingerprint(msg)).toBe(true);
  });

  test('65507-byte datagram with a channel does not crash; Binding still answers', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CHANNEL_BIND,
        nonce,
        [
          addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx),
          channelNumberAttribute(0x4008),
        ],
        tx
      ),
      port
    );
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    const allocation = serverCtx(server).table.getByClient({
      address: client.address,
      port: client.port,
    });
    allocation?.socket.emit('message', Buffer.alloc(65_507, 4), {
      address: peer.address,
      family: 'IPv4',
      port: peer.port,
      size: 65_507,
    });
    allocation?.socket.emit('message', Buffer.alloc(65_532, 5), {
      address: peer.address,
      family: 'IPv4',
      port: peer.port,
      size: 65_532,
    });
    expect(server.snapshot().droppedOversized ?? 0).toBeGreaterThanOrEqual(1);
    client.send(bindingRequest(), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().listening).toBe(true);
  });
});

describe('permission caps', () => {
  test('17 XOR-PEER-ADDRESS in one CreatePermission is 400', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    const peers = Array.from({ length: MAX_XOR_PEERS_PER_REQUEST + 1 }, (_, i) => ({
      address: '203.0.113.1',
      port: 40_000 + i,
    }));
    expect(errorCodeOf(await permitPeers(client, port, nonce, peers))).toBe(400);
    expect(server.snapshot().permissions).toBe(0);
  });

  test('32 permissions per allocation; excess is 400; existing still refresh', async () => {
    const { server, port, advance } = await boot();
    const client = await openClient();
    const { nonce } = await allocate(client, port);
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        address: '203.0.113.2',
        port: 41_000 + from + i,
      }));
    expect((await permitPeers(client, port, nonce, batch(0, 16))).class).toBe(CLASS.SUCCESS);
    expect((await permitPeers(client, port, nonce, batch(16, 16))).class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().permissions).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
    expect(errorCodeOf(await permitPeers(client, port, nonce, batch(32, 1)))).toBe(400);
    expect(server.snapshot().permissions).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
    expect((await permitPeers(client, port, nonce, batch(0, 16))).class).toBe(CLASS.SUCCESS);
    expect(server.snapshot().permissions).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
    const tx = randomBytes(12);
    client.send(
      authed(
        METHOD.CHANNEL_BIND,
        nonce,
        [
          addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: '203.0.113.9', port: 9 }, tx),
          channelNumberAttribute(0x4010),
        ],
        tx
      ),
      port
    );
    expect(errorCodeOf(await recvStun(client.inbox))).toBe(400);
    advance(200_000);
    expect((await permitPeers(client, port, nonce, batch(0, 1))).class).toBe(CLASS.SUCCESS);
    advance(150_000);
    expect(server.snapshot().permissions).toBe(1);
  });
});

describe('unauthenticated response rate limit', () => {
  test('Binding success is token-bucketed per source IP', async () => {
    const { server, port, advance } = await boot();
    const client = await openClient();
    for (let i = 0; i < UNAUTH_PER_IP_BURST; i++) client.send(bindingRequest(), port);
    for (let i = 0; i < UNAUTH_PER_IP_BURST; i++) {
      expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    }
    client.send(bindingRequest(), port);
    await expect(client.inbox.take(200)).rejects.toThrow('udp timeout');
    expect(server.snapshot().droppedUnauthRateLimit).toBe(1);
    advance(1_000);
    client.send(bindingRequest(), port);
    expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
  });

  test('401 challenges share the unauth bucket; Send indications are not limited', async () => {
    const { server, port } = await boot();
    const client = await openClient();
    const peer = await openClient();
    const { nonce } = await allocate(client, port);
    expect((await permitPeers(client, port, nonce, [peer])).class).toBe(CLASS.SUCCESS);
    for (let i = 0; i < UNAUTH_PER_IP_BURST - 1; i++) client.send(bindingRequest(), port);
    for (let i = 0; i < UNAUTH_PER_IP_BURST - 1; i++) {
      expect((await recvStun(client.inbox)).class).toBe(CLASS.SUCCESS);
    }
    client.send(
      encodeMessage({
        method: METHOD.ALLOCATE,
        class: CLASS.REQUEST,
        attributes: [requestedTransportAttribute()],
        fingerprint: true,
      }),
      port
    );
    await expect(client.inbox.take(200)).rejects.toThrow('udp timeout');
    expect(server.snapshot().droppedUnauthRateLimit ?? 0).toBeGreaterThanOrEqual(1);
    const sendTx = randomBytes(12);
    client.send(
      encodeMessage({
        method: METHOD.SEND,
        class: CLASS.INDICATION,
        transactionId: sendTx,
        attributes: [
          addressAttribute(
            ATTR.XOR_PEER_ADDRESS,
            { address: peer.address, port: peer.port },
            sendTx
          ),
          { type: ATTR.DATA, value: Buffer.from('still-ok') },
        ],
        fingerprint: true,
      }),
      port
    );
    const incoming = await peer.inbox.take();
    expect(incoming.msg.equals(Buffer.from('still-ok'))).toBe(true);
  });
});
