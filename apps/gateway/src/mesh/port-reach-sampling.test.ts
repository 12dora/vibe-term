import { afterEach, describe, expect, test } from 'bun:test';
import type { UserStore } from '../auth/user-store';
import { PeerPathRttMemory } from './peer-path-rtt';
import {
  PORT_PROBE_CADENCE_MS,
  attachPortReachToMesh,
  probePeerEndpoints,
  resetPortReachForTest,
} from './port-reach';
import { type TcpConnectFn, type TcpProbeSocket, probeTcpConnect } from './port-reach-probe';

const PEER = 'cc'.repeat(16);
const ENDPOINT = 'ws://203.0.113.10:39001/peer';

function fakeConnect() {
  const pending: Array<{
    host: string;
    port: number;
    socket: TcpProbeSocket;
    succeed: () => void;
    refuse: () => void;
    destroyed: boolean;
  }> = [];
  const connect: TcpConnectFn = ({ host, port }) => {
    let onConnect = () => {};
    let onError = (_err: NodeJS.ErrnoException) => {};
    const row = {
      host,
      port,
      socket: {
        once(event: string, listener: (() => void) | ((err: NodeJS.ErrnoException) => void)) {
          if (event === 'connect') onConnect = listener as () => void;
          else onError = listener;
        },
        destroy() {
          row.destroyed = true;
        },
      },
      succeed: () => onConnect(),
      refuse: () => onError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      destroyed: false,
    };
    pending.push(row);
    return row.socket;
  };
  return { connect, pending };
}

describe('TCP path RTT sampling', () => {
  afterEach(() => resetPortReachForTest());

  test('launches three independent connects before completion and records every success', async () => {
    const fake = fakeConnect();
    const memory = new PeerPathRttMemory();
    resetPortReachForTest({
      trust: async () => true,
      probeFn: (host, port, deadlineMs) => probeTcpConnect(host, port, deadlineMs, fake.connect),
    });
    const result = probePeerEndpoints(PEER, [ENDPOINT], { pathRttMemory: memory });
    expect(fake.pending).toHaveLength(3);
    expect(new Set(fake.pending.map((row) => row.socket)).size).toBe(3);
    for (const row of fake.pending) {
      expect({ host: row.host, port: row.port }).toEqual({ host: '203.0.113.10', port: 39001 });
      row.succeed();
    }
    expect((await result).lastVerdict).toBe('ok');
    expect(memory.samplesOf(PEER)).toHaveLength(3);
    for (const sample of memory.samplesOf(PEER)) {
      expect(sample.kind).toBe('tcp-connect');
      expect(sample.rttMs).toBeGreaterThanOrEqual(0);
    }
    expect(fake.pending.every((row) => row.destroyed)).toBe(true);
  });

  test('any success opens the endpoint; failed connects do not contribute RTT samples', async () => {
    const fake = fakeConnect();
    const memory = new PeerPathRttMemory();
    resetPortReachForTest({
      trust: async () => true,
      probeFn: (host, port, deadlineMs) => probeTcpConnect(host, port, deadlineMs, fake.connect),
    });
    const result = probePeerEndpoints(PEER, [ENDPOINT], { pathRttMemory: memory });
    fake.pending[0].refuse();
    fake.pending[1].succeed();
    fake.pending[2].refuse();
    expect((await result).status).toBe('open');
    expect(memory.samplesOf(PEER)).toHaveLength(1);
  });

  test('three failures count as one cadence failure and repeat only after five minutes', async () => {
    let now = 1_000;
    let calls = 0;
    const memory = new PeerPathRttMemory();
    resetPortReachForTest({
      trust: async () => true,
      now: () => now,
      probeFn: async () => {
        calls += 1;
        return { verdict: 'refused', connectMs: null };
      },
    });
    const opts = { pathRttMemory: memory };
    expect((await probePeerEndpoints(PEER, [ENDPOINT], opts)).consecutiveFails).toBe(1);
    now += PORT_PROBE_CADENCE_MS - 1;
    await probePeerEndpoints(PEER, [ENDPOINT], opts);
    expect(calls).toBe(3);
    now += 1;
    expect((await probePeerEndpoints(PEER, [ENDPOINT], opts)).status).toBe('blocked');
    expect(calls).toBe(6);
    expect(memory.samplesOf(PEER)).toHaveLength(0);
  });

  test('mesh timer samples into the memory it was given; omitting it keeps probing', async () => {
    let now = 1_000;
    const memory = new PeerPathRttMemory();
    const userStore = {
      listPeers: () => [{ nodeId: PEER, endpointsJson: JSON.stringify([ENDPOINT]) }],
    } as UserStore;
    resetPortReachForTest({
      trust: async () => true,
      now: () => now,
      probeFn: async () => ({ verdict: 'ok', connectMs: 90 }),
    });
    const selfNodeId = 'aa'.repeat(16);
    const firstStop = attachPortReachToMesh({ selfNodeId, userStore, pathRttMemory: memory });
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstStop();
    expect(memory.samplesOf(PEER)).toHaveLength(3);
    now += PORT_PROBE_CADENCE_MS;
    const secondStop = attachPortReachToMesh({ selfNodeId, userStore });
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondStop();
    expect(memory.samplesOf(PEER)).toHaveLength(3);
  });
});

import { aggregateProbeVerdicts } from './port-reach';

describe('aggregateProbeVerdicts', () => {
  test('any ok wins, all refused stays refused, mixed failures resolve to timeout regardless of order', () => {
    expect(aggregateProbeVerdicts(['timeout', 'ok', 'refused'])).toBe('ok');
    expect(aggregateProbeVerdicts(['refused', 'refused', 'refused'])).toBe('refused');
    expect(aggregateProbeVerdicts(['refused', 'timeout', 'timeout'])).toBe('timeout');
    expect(aggregateProbeVerdicts(['timeout', 'timeout', 'refused'])).toBe('timeout');
    expect(aggregateProbeVerdicts([])).toBe('timeout');
  });
});
