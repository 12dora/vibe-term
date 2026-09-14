import { afterEach, describe, expect, test } from 'bun:test';
import { type AddressInfo, type Socket, createServer } from 'node:net';
import {
  INITIAL_STREAM_WINDOW,
  type LinkSession,
  MAX_DATA_SEND_PAYLOAD,
  createInMemoryLinkPair,
} from '@vibeterm/shared/link';
import type { AuthDb } from '../../auth/types';
import { resetPeerStreamSlots } from '../../portmap/budget';
import { dialTcp } from '../../portmap/dial';
import { shutdownWriteHalf } from '../../portmap/half-close';
import { PortMapManager } from '../../portmap/manager';
import { isPortFree } from '../../portmap/port-probe';
import { PENDING_HIGH_WATER } from '../../portmap/pump';
import { PortMapExportStore, PortMapStore } from '../../portmap/store';
import {
  type EchoServer,
  startAfterFinServer,
  startEchoServer,
} from '../../portmap/test-echo-server';
import {
  type RelayMeshHarness,
  bootRelayMeshHarness,
} from '../../relay/integration/relay-mesh-harness';
import type { MeshRuntime } from '../mesh-runtime';

/** 让测试能制造「链路还在拨」的窗口。 */
const linkDial = { delayMs: 0, count: 0 };
type MuxStats = { stats?: () => { unacked: number } };
const lastMux: { current: MuxStats | null } = { current: null };

function peerLinkFactory(
  selfId: string,
  remote: { mesh: MeshRuntime | null }
): (peerNodeId: string, signal: AbortSignal) => Promise<LinkSession | null> {
  return async (peerNodeId) => {
    if (!remote.mesh || remote.mesh.nodeId !== peerNodeId) return null;
    linkDial.count += 1;
    if (linkDial.delayMs > 0) await Bun.sleep(linkDial.delayMs);
    const [local, other] = createInMemoryLinkPair();
    lastMux.current = local as MuxStats;
    remote.mesh.peers.adoptLink(selfId, other, 'ws-secure', selfId);
    return local;
  };
}

type Fixture = { close: () => void; stop?: () => Promise<void> };
const fixtures: Fixture[] = [];

async function bootPair(): Promise<{
  a: { mesh: MeshRuntime; db: AuthDb };
  b: { mesh: MeshRuntime; db: AuthDb };
}> {
  const holderB = { mesh: null as MeshRuntime | null };
  const holderA = { mesh: null as MeshRuntime | null };
  const h: RelayMeshHarness = await bootRelayMeshHarness();
  fixtures.push({ close: () => {}, stop: () => h.stop() });
  const tenant = await h.createTenant('alice', {
    roles: { node: true, relay: false },
    peerPort: 0,
    stunServers: [],
    linkFactoryFor: (id) => peerLinkFactory(id, holderB),
    loadNative: async () => null,
  });
  await tenant.enroll();
  holderA.mesh = tenant.owner.mesh;
  const bNode = await tenant.joinNode('node-b', {
    roles: { node: true, relay: false },
    peerPort: 0,
    stunServers: [],
    linkFactoryFor: (id) => peerLinkFactory(id, holderA),
    loadNative: async () => null,
  });
  holderB.mesh = bNode.mesh;
  return {
    a: { mesh: tenant.owner.mesh, db: tenant.owner.db },
    b: { mesh: bNode.mesh, db: bNode.db },
  };
}

type TcpClient = {
  socket: Socket;
  send: (payload: Uint8Array) => Promise<void>;
  received: () => number;
  waitFor: (total: number) => Promise<Uint8Array>;
  waitHash: (total: number) => Promise<number>;
  waitClosed: () => Promise<void>;
  halfClose: () => void;
  close: () => void;
};

/**
 * xorshift32 伪随机流：每条连接一个种子、一个长度。定长斜坡（每 256 字节重复）无法暴露
 * 「整块被同长度的另一块替换」或「两条连接的响应互换」，伪随机 + 各不相同的长度才能。
 */
function pseudoRandom(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size + 4);
  const words = new Uint32Array(out.buffer, 0, (size + 3) >> 2);
  let state = seed >>> 0 || 0x9e37_79b9;
  for (let i = 0; i < words.length; i += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = state ^ (state >>> 17);
    state = (state ^ (state << 5)) >>> 0;
    words[i] = state;
  }
  return out.subarray(0, size);
}

const KEEP_CHUNKS_LIMIT = 8 * 1024 * 1024;

function fnv1a(bytes: Uint8Array, seed = 2_166_136_261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    hash = Math.imul(hash ^ (bytes[i] as number), 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

async function tcpClient(port: number): Promise<TcpClient> {
  const socket = await dialTcp({ host: '127.0.0.1', port }, 5_000).result;
  // 普通客户端：不打 allowHalfOpen，对端 FIN 就整条收掉，close 事件才会来
  socket.allowHalfOpen = false;
  socket.setNoDelay(true);
  const chunks: Uint8Array[] = [];
  const state = { received: 0, hash: 2_166_136_261, closed: false };
  const wake: Array<() => void> = [];
  const ping = (): void => {
    for (const fn of wake.splice(0)) fn();
  };
  socket.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (state.received < KEEP_CHUNKS_LIMIT) chunks.push(bytes);
    state.received += bytes.byteLength;
    state.hash = fnv1a(bytes, state.hash);
    ping();
  });
  socket.on('close', () => {
    state.closed = true;
    ping();
  });
  socket.on('error', () => {});
  const tick = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake.push(resolve);
      setTimeout(resolve, 25);
    });
  const until = async (total: number): Promise<void> => {
    const deadline = Date.now() + 120_000;
    while (state.received < total) {
      if (state.closed) throw new Error(`socket closed after ${state.received} of ${total} bytes`);
      if (Date.now() > deadline) throw new Error(`timed out at ${state.received} of ${total}`);
      await tick();
    }
  };
  return {
    socket,
    received: () => state.received,
    send: (payload) =>
      new Promise<void>((resolve, reject) => {
        socket.write(payload, (err) => (err ? reject(err) : resolve()));
      }),
    async waitFor(total) {
      await until(total);
      const out = new Uint8Array(state.received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out.subarray(0, total);
    },
    async waitHash(total) {
      await until(total);
      return state.hash;
    },
    async waitClosed() {
      const deadline = Date.now() + 10_000;
      while (!state.closed) {
        if (Date.now() > deadline) throw new Error('socket stayed open');
        await tick();
      }
    },
    halfClose() {
      const handle = (socket as Socket & { _handle?: { readyState: number; fd: number } })._handle;
      if (!handle || !shutdownWriteHalf(handle)) throw new Error('half close unavailable');
    },
    close() {
      socket.destroy();
    },
  };
}

/**
 * 一开始完全不读的回声服务。目标应用层不读，内核 TCP 缓冲是 mux 窗口之外唯一的另一只槽。
 */
function startPausedEchoServer(): EchoServer & {
  release: () => void;
  lastSocket: () => Socket | null;
} {
  const state = { connections: 0, last: null as Socket | null };
  const sockets = new Set<Socket>();
  const held: Socket[] = [];
  let released = false;
  const server = createServer({ allowHalfOpen: true, noDelay: true });
  server.on('error', () => {});
  server.on('connection', (socket) => {
    state.connections += 1;
    state.last = socket;
    sockets.add(socket);
    socket.allowHalfOpen = true;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (!socket.write(chunk)) socket.pause();
    });
    socket.on('drain', () => {
      if (released) socket.resume();
    });
    socket.on('end', () => socket.end());
    if (released) return;
    socket.pause();
    held.push(socket);
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('failed to bind paused echo server');
  return {
    port: address.port,
    get connections() {
      return state.connections;
    },
    lastSocket: () => state.last,
    release() {
      released = true;
      for (const socket of held.splice(0)) socket.resume();
    },
    stop() {
      try {
        server.close();
      } catch {
        // 已经关闭
      }
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
  };
}

async function waitBytesOutPlateau(read: () => number, timeoutMs = 2_000): Promise<number> {
  let stalled = 0;
  let stableTicks = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stableTicks < 4) {
    await Bun.sleep(50);
    const n = read();
    if (n === stalled && n > 0) stableTicks += 1;
    else {
      stalled = n;
      stableTicks = n > 0 ? 1 : 0;
    }
  }
  return stalled;
}

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

describe('portmap mesh integration', () => {
  const managers: PortMapManager[] = [];
  const servers: Array<{ stop: () => void }> = [];

  afterEach(async () => {
    linkDial.delayMs = 0;
    linkDial.count = 0;
    lastMux.current = null;
    resetPeerStreamSlots();
    while (managers.length > 0) managers.pop()?.stop();
    while (servers.length > 0) servers.pop()?.stop();
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  async function setup(opts: { mapId?: string; withExport?: boolean; target?: EchoServer } = {}) {
    const mapId = opts.mapId ?? 'integration-map-1';
    const { a, b } = await bootPair();
    const echo = opts.target ?? startEchoServer();
    servers.push(echo);
    if (opts.withExport !== false) {
      new PortMapExportStore(b.db).insert({
        mapId,
        fromNodeId: a.mesh.nodeId,
        host: '127.0.0.1',
        port: echo.port,
        enabled: true,
        createdAt: Date.now(),
      });
    }
    const manager = new PortMapManager({
      store: new PortMapStore(a.db),
      peers: () => a.mesh.peers,
      reservedPorts: () => [],
    });
    managers.push(manager);
    manager.start();
    const map = manager.create({
      name: 'echo',
      listenPort: freePort(),
      targetNodeId: b.mesh.nodeId,
      targetPort: echo.port,
      mapId,
    });
    return { a, b, echo, manager, map };
  }

  test('round-trips bytes from A to an echo server on B', async () => {
    const { manager, map, echo } = await setup();
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('hello mesh'));
    const back = await client.waitFor(10);
    expect(new TextDecoder().decode(back)).toBe('hello mesh');
    expect(echo.connections).toBe(1);
    await Bun.sleep(30);
    const dto = manager.get(map.id);
    expect(dto.activeConnections).toBe(1);
    expect(dto.totalConnections).toBe(1);
    expect(dto.bytesIn).toBe(10);
    expect(dto.bytesOut).toBe(10);
    client.close();
  });

  test('carries more than one MiB through the mesh', async () => {
    const { manager, map } = await setup();
    const client = await tcpClient(map.listenPort);
    const size = 1024 * 1024 + 8192;
    const payload = pseudoRandom(size, 0x1234_5678);
    await client.send(payload);
    const back = await client.waitFor(size);
    expect(back.byteLength).toBe(size);
    expect(fnv1a(back)).toBe(fnv1a(payload));
    await Bun.sleep(50);
    expect(client.received()).toBe(size);
    expect(manager.get(map.id).bytesOut).toBe(size);
    client.close();
  });

  test('carries a payload far larger than the mux window', async () => {
    const { manager, map } = await setup();
    const client = await tcpClient(map.listenPort);
    const size = 56 * 1024 * 1024 + 7_777;
    const payload = pseudoRandom(size, 0x00c0_ffee);
    const sent = client.send(payload);
    const hash = await client.waitHash(size);
    await sent;
    expect(hash).toBe(fnv1a(payload));
    await Bun.sleep(50);
    expect(client.received()).toBe(size);
    expect(manager.get(map.id).bytesOut).toBe(size);
    expect(manager.get(map.id).bytesIn).toBe(size);
    client.close();
  }, 180_000);

  test('runs eight concurrent connections over one peer link', async () => {
    const { manager, map } = await setup();
    // 每条连接一份不同种子、不同长度的伪随机流：整块替换或连接间串流都会被自己的哈希抓住
    const jobs = Array.from({ length: 8 }, (_unused, i) => {
      const size = 5 * 1024 * 1024 + i * 512 * 1024 + i * 37;
      return { size, payload: pseudoRandom(size, 0x51ed_0000 + i) };
    });
    const clients = await Promise.all(jobs.map(() => tcpClient(map.listenPort)));
    const runs = clients.map(async (client, i) => {
      const job = jobs[i] as { size: number; payload: Uint8Array };
      const sent = client.send(job.payload);
      const hash = await client.waitHash(job.size);
      await sent;
      return hash;
    });
    const hashes = await Promise.all(runs);
    for (const [i, job] of jobs.entries()) {
      expect(hashes[i]).toBe(fnv1a(job.payload));
      expect(clients[i]?.received()).toBe(job.size);
    }
    await Bun.sleep(50);
    const dto = manager.get(map.id);
    expect(dto.totalConnections).toBe(8);
    expect(dto.bytesOut).toBe(jobs.reduce((sum, job) => sum + job.size, 0));
    for (const client of clients) client.close();
  }, 180_000);

  test('propagates half-close from the local client', async () => {
    const { map } = await setup();
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('bye'));
    const back = await client.waitFor(3);
    expect(new TextDecoder().decode(back)).toBe('bye');
    client.halfClose();
    await client.waitClosed();
  });

  test('a paused map refuses new connections and resumes on demand', async () => {
    const { manager, map } = await setup();
    manager.update(map.id, { paused: true });
    expect(isPortFree('127.0.0.1', map.listenPort)).toBe(true);
    await expect(tcpClient(map.listenPort)).rejects.toThrow();
    expect(manager.update(map.id, { paused: false }).state).toBe('listening');
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('up'));
    expect(new TextDecoder().decode(await client.waitFor(2))).toBe('up');
    client.close();
  });

  test('closes the connection when B has no matching export row', async () => {
    const { echo, map } = await setup({ withExport: false });
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('nope'));
    await client.waitClosed();
    expect(echo.connections).toBe(0);
  });

  test('delete stops the listener and frees the port', async () => {
    const { manager, map } = await setup();
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('x'));
    await client.waitFor(1);
    manager.remove(map.id);
    await client.waitClosed();
    expect(isPortFree('127.0.0.1', map.listenPort)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  test('delivers a reply the target only produces after the client half-closes', async () => {
    const target = startAfterFinServer(new TextEncoder().encode('reply-after-fin'));
    const { map } = await setup({ target });
    const client = await tcpClient(map.listenPort);
    await client.send(new TextEncoder().encode('request'));
    await Bun.sleep(50);
    // 客户端只关写半边（node:net 的 end() 也会连读半边一起关，这里直接走 POSIX shutdown）
    client.halfClose();
    const back = await client.waitFor(15);
    expect(new TextDecoder().decode(back)).toBe('reply-after-fin');
    expect(target.received()).toBe(7);
    client.close();
  });

  test('backs off on a slow target instead of buffering, and the link keeps working', async () => {
    const slow = startPausedEchoServer();
    const { manager, map } = await setup({ target: slow });
    const client = await tcpClient(map.listenPort);
    const size = 64 * 1024 * 1024 + 999;
    const payload = pseudoRandom(size, 0x5107_0001);
    const pushed = client.send(payload).catch(() => {});
    const stalled = await waitBytesOutPlateau(() => manager.get(map.id).bytesOut);
    const dto = manager.get(map.id);
    // 泵队列：高水位停读之后最多再收一块 socket 数据。Bun 没有 SO_* 访问器，
    // 不能从运行时量内核缓冲；目标暂停不读，应用层只剩 pendingBytes + mux 未确认窗口。
    expect(dto.pendingBytes ?? 0).toBeLessThanOrEqual(PENDING_HIGH_WATER + MAX_DATA_SEND_PAYLOAD);
    const unacked = lastMux.current?.stats?.().unacked ?? 0;
    expect(unacked).toBeLessThanOrEqual(INITIAL_STREAM_WINDOW);
    expect(stalled).toBeGreaterThan(0);
    // 粗粒度兜底：64 MiB 载荷下 bytesOut 含内核缓冲（CI ubuntu 约 15.5 MiB），不得把整包吞进进程。
    expect(stalled).toBeLessThan(size / 2);
    slow.release();
    await pushed;
    const hash = await client.waitHash(size);
    expect(hash).toBe(fnv1a(payload));
    const second = await tcpClient(map.listenPort);
    await second.send(new TextEncoder().encode('ping'));
    expect(new TextDecoder().decode(await second.waitFor(4))).toBe('ping');
    client.close();
    second.close();
  }, 180_000);

  test('keeps the bytes sent while the peer link is still being dialled', async () => {
    linkDial.delayMs = 300;
    const { map } = await setup();
    const before = linkDial.count;
    const client = await tcpClient(map.listenPort);
    const size = 2 * 1024 * 1024 + 321;
    const payload = pseudoRandom(size, 0xc01d_d1a1);
    await client.send(payload);
    const back = await client.waitFor(size);
    expect(back.byteLength).toBe(size);
    expect(fnv1a(back)).toBe(fnv1a(payload));
    expect(client.received()).toBe(size);
    expect(linkDial.count).toBeGreaterThan(before);
    client.close();
  });
});
