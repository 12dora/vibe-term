import { afterEach, describe, expect, test } from 'bun:test';
import dgram from 'node:dgram';
import { AllocationTable } from './allocation-table';
import { MAX_PERMISSIONS_PER_ALLOCATION } from './turn-limits';
import { closeSocket } from './turn-udp';

const sockets: dgram.Socket[] = [];

afterEach(async () => {
  while (sockets.length) await closeSocket(sockets.pop());
});

function table(now = 1_000): AllocationTable {
  return new AllocationTable({
    listenHost: '127.0.0.1',
    relayPortRange: { begin: 1, end: 1 },
    maxAllocations: 8,
    maxAllocationsPerUser: 8,
    bytesPerSecPerAllocation: 0,
    now: () => now,
  });
}

function insert(target: AllocationTable) {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  return target.insert({
    key: 'client',
    user: 'alice',
    password: 'secret',
    client: { address: '127.0.0.1', port: 9 },
    socket,
    relayPort: 1,
    lifetimeSec: 600,
  });
}

describe('permission cap', () => {
  test('installPermission caps at 32 and still refreshes existing', () => {
    const target = table(5_000);
    const allocation = insert(target);
    for (let i = 0; i < MAX_PERMISSIONS_PER_ALLOCATION; i++) {
      expect(target.installPermission(allocation, '203.0.113.1', 1000 + i, 5_000)).toBe(true);
    }
    expect(allocation.permissions.size).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
    expect(target.installPermission(allocation, '203.0.113.1', 2000, 5_000)).toBe(false);
    expect(allocation.permissions.size).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
    expect(target.installPermission(allocation, '203.0.113.1', 1000, 9_000)).toBe(true);
    expect(allocation.permissions.get('203.0.113.1#1000')?.expiresAt).toBe(9_000 + 300_000);
    expect(allocation.permissions.size).toBe(MAX_PERMISSIONS_PER_ALLOCATION);
  });

  test('bindChannel to a new peer at the cap is full; existing peer is ok', () => {
    const target = table(5_000);
    const allocation = insert(target);
    for (let i = 0; i < MAX_PERMISSIONS_PER_ALLOCATION; i++) {
      target.installPermission(allocation, '203.0.113.8', 10 + i, 5_000);
    }
    expect(target.bindChannel(allocation, 0x4000, '203.0.113.9', 9, 5_000)).toBe('full');
    expect(allocation.channels.size).toBe(0);
    expect(target.bindChannel(allocation, 0x4001, '203.0.113.8', 10, 5_000)).toBe('ok');
    expect(allocation.channels.size).toBe(1);
  });
});
