import { afterEach, describe, expect, test } from 'bun:test';
import dgram from 'node:dgram';
import { type Allocation, AllocationTable, peerKey } from './allocation-table';
import { decodeChannelData, isChannelData, maxDataIndicationPayload } from './stun-message';
import { NonceStore } from './turn-auth';
import type { MutableStats, TurnContext } from './turn-context';
import { MAX_CHANNEL_DATA_PAYLOAD } from './turn-limits';
import { guardTurnHandler, handlePeerDatagram } from './turn-relay-io';
import { closeSocket } from './turn-udp';
import { UnauthResponseLimiter } from './turn-unauth-limit';

const sockets: dgram.Socket[] = [];

afterEach(async () => {
  while (sockets.length) await closeSocket(sockets.pop());
});

function emptyStats(): MutableStats {
  return {
    listening: true,
    port: 3478,
    externalIp: '203.0.113.10',
    allocations: 0,
    permissions: 0,
    channels: 0,
    bytesRelayedIn: 0,
    bytesRelayedOut: 0,
    authFailures: 0,
    deniedPeers: 0,
    bindingRequests: 0,
    startedAt: 1,
    droppedNoPermission: 0,
    droppedRateLimit: 0,
    droppedOversized: 0,
    droppedUnauthRateLimit: 0,
  };
}

function makeCtx(): { ctx: TurnContext; sent: Buffer[] } {
  const sent: Buffer[] = [];
  const now = () => 1_000;
  const table = new AllocationTable({
    listenHost: '127.0.0.1',
    relayPortRange: { begin: 1, end: 1 },
    maxAllocations: 8,
    maxAllocationsPerUser: 8,
    bytesPerSecPerAllocation: 0,
    now,
  });
  const ctx: TurnContext = {
    options: {
      listenHost: '127.0.0.1',
      listenPort: 3478,
      relayPortRange: { begin: 1, end: 1 },
      externalIp: '203.0.113.10',
      realm: 'vibeterm',
      credentials: () => 'secret',
      maxAllocations: 8,
      maxAllocationsPerUser: 8,
      maxLifetimeSec: 3600,
      deniedPeerCidrs: [],
      bytesPerSecPerAllocation: 0,
      log: () => {},
      now,
    },
    stats: emptyStats(),
    table,
    nonce: new NonceStore(now),
    unauthLimit: new UnauthResponseLimiter(now),
    denied: () => false,
    send: (buf) => {
      sent.push(buf);
    },
  };
  return { ctx, sent };
}

function makeAllocation(ctx: TurnContext): Allocation {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  return ctx.table.insert({
    key: '127.0.0.1#9',
    user: 'alice',
    password: 'secret',
    client: { address: '127.0.0.1', port: 9 },
    socket,
    relayPort: 1,
    lifetimeSec: 600,
  });
}

describe('oversized peer datagrams', () => {
  test('drops a 65507-byte payload without a channel and counts it', () => {
    const { ctx, sent } = makeCtx();
    const allocation = makeAllocation(ctx);
    const peer = { address: '203.0.113.50', port: 4242 };
    ctx.table.installPermission(allocation, peer.address, peer.port, 1_000);
    handlePeerDatagram(ctx, allocation, Buffer.alloc(65_507, 7), peer);
    expect(ctx.stats.droppedOversized).toBe(1);
    expect(sent).toHaveLength(0);
    expect(ctx.stats.bytesRelayedIn).toBe(0);
    expect(65_507).toBeGreaterThan(maxDataIndicationPayload(4));
  });

  test('65507-byte payload with a channel is under ChannelData cap and is forwarded', () => {
    const { ctx, sent } = makeCtx();
    const allocation = makeAllocation(ctx);
    const peer = { address: '203.0.113.50', port: 4242 };
    expect(ctx.table.bindChannel(allocation, 0x4005, peer.address, peer.port, 1_000)).toBe('ok');
    handlePeerDatagram(ctx, allocation, Buffer.alloc(65_507, 8), peer);
    expect(ctx.stats.droppedOversized).toBe(0);
    expect(sent).toHaveLength(1);
    const packed = sent[0];
    expect(packed && isChannelData(packed)).toBe(true);
    expect(packed && decodeChannelData(packed)?.data.length).toBe(65_507);
    expect(65_507).toBeLessThanOrEqual(MAX_CHANNEL_DATA_PAYLOAD);
  });

  test('drops ChannelData that would exceed 65535 and swallows handler throws', () => {
    const { ctx, sent } = makeCtx();
    const allocation = makeAllocation(ctx);
    const peer = { address: '203.0.113.50', port: 4242 };
    expect(ctx.table.bindChannel(allocation, 0x4005, peer.address, peer.port, 1_000)).toBe('ok');
    handlePeerDatagram(ctx, allocation, Buffer.alloc(MAX_CHANNEL_DATA_PAYLOAD + 1, 9), peer);
    expect(ctx.stats.droppedOversized).toBe(1);
    expect(sent).toHaveLength(0);
    guardTurnHandler(ctx, () => {
      throw new RangeError('STUN message too large');
    });
    expect(ctx.stats.droppedOversized).toBe(2);
    const key = peerKey(peer.address, peer.port);
    expect(allocation.permissions.has(key)).toBe(true);
  });
});
