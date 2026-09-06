import { afterEach, describe, expect, test } from 'bun:test';
import { type Socket, connect, createServer } from 'node:net';
import { type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import { encodeJsonBytes } from '../mesh/ctl';
import { shutdownWriteHalf } from './half-close';
import { openLibc } from './libc';
import { type PumpSocketData, TcpStreamPump, attachPump, createPumpSocketData } from './pump';
import { attachPumpSocketHandlers, netPumpSocket, prepareSocket } from './socket-handlers';
import {
  isSocketAlive,
  scanSocketLiveness,
  socketHandle,
  watchedSocketCount,
} from './socket-liveness';
import { createPortMapCounters } from './types';

const SOL_SOCKET = process.platform === 'darwin' ? 0xffff : 1;
const SO_LINGER = process.platform === 'darwin' ? 0x0080 : 13;

/** `SO_LINGER{1,0}` + close：让内核发真正的 RST，而不是 FIN。 */
function abortSocket(socket: Socket): boolean {
  const handle = socketHandle(socket);
  const lib = openLibc((t) => ({
    setsockopt: { args: [t.i32, t.i32, t.i32, t.ptr, t.u32], returns: t.i32 },
  }));
  const symbol = lib?.symbols.setsockopt;
  if (!handle || !lib || !symbol) return false;
  const linger = new Int32Array([1, 0]);
  const rc = symbol(
    handle.fd as never,
    SOL_SOCKET as never,
    SO_LINGER as never,
    lib.ptr(linger) as never,
    8 as never
  );
  socket.destroy();
  return rc === 0;
}

type Tunnel = {
  socket: Socket;
  data: PumpSocketData;
  remote: LinkStream;
  disposed: () => boolean;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: Array<() => void> = [];

/** 真实连接：本地 node:net socket ⇄ 泵 ⇄ in-memory mux，B 侧拿到流之后一个字节都不读。 */
function startStalledServer(): { port: number; tunnel: Promise<Tunnel> } {
  const [linkA, linkB] = createInMemoryLinkPair();
  cleanups.push(() => {
    linkA.close('test-done');
    linkB.close('test-done');
  });
  const remoteReady = deferred<LinkStream>();
  linkB.onStream((stream) => remoteReady.resolve(stream));
  const tunnelReady = deferred<Tunnel>();
  const server = createServer({ allowHalfOpen: true, noDelay: true });
  server.on('error', () => {});
  server.on('connection', (socket) => {
    const data = createPumpSocketData();
    let disposed = false;
    data.onDisposed = () => {
      disposed = true;
    };
    prepareSocket(socket);
    attachPumpSocketHandlers(socket, data);
    void linkA.openStream(encodeJsonBytes({ type: 'tcp' })).then(async (stream) => {
      attachPump(data, new TcpStreamPump(netPumpSocket(socket), stream, createPortMapCounters()));
      tunnelReady.resolve({
        socket,
        data,
        remote: await remoteReady.promise,
        disposed: () => disposed,
      });
    });
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  return { port: address.port, tunnel: tunnelReady.promise };
}

function startClient(port: number): Socket {
  const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.allowHalfOpen = true;
  socket.on('error', () => {});
  cleanups.push(() => socket.destroy());
  return socket;
}

describe('portmap socket liveness', () => {
  afterEach(async () => {
    while (cleanups.length > 0) cleanups.pop()?.();
    await Bun.sleep(20);
    scanSocketLiveness();
  });

  test('a healthy connection is never mistaken for a dead one', async () => {
    const { port, tunnel } = startStalledServer();
    const client = startClient(port);
    const fx = await tunnel;
    await new Promise<void>((done) => client.write('ping', () => done()));
    await Bun.sleep(30);
    expect(isSocketAlive(fx.socket)).toBe(true);
    scanSocketLiveness();
    expect(fx.disposed()).toBe(false);
    expect(fx.socket.destroyed).toBe(false);
  });

  test('a socket half-closed by us stays alive', async () => {
    const { port, tunnel } = startStalledServer();
    const client = startClient(port);
    const fx = await tunnel;
    const handle = socketHandle(fx.socket);
    expect(handle).not.toBeNull();
    expect(handle && shutdownWriteHalf(handle)).toBe(true);
    await Bun.sleep(30);
    scanSocketLiveness();
    expect(fx.disposed()).toBe(false);
    expect(isSocketAlive(fx.socket)).toBe(true);
  });

  test('reclaims a paused connection whose peer resets while the consumer is stalled', async () => {
    const { port, tunnel } = startStalledServer();
    const client = startClient(port);
    const fx = await tunnel;
    // B 侧一个字节都不读：窗口撑满之后泵越过高水位停读，socket 上再没有任何事件会冒出来
    client.write(new Uint8Array(8 * 1024 * 1024));
    await Bun.sleep(200);
    expect(abortSocket(client)).toBe(true);
    await Bun.sleep(100);
    expect(fx.disposed()).toBe(false);
    scanSocketLiveness();
    expect(fx.disposed()).toBe(true);
    expect(fx.socket.destroyed).toBe(true);
    expect((await fx.remote.closed).reason).toBe('rst');
  });

  test('reclaims a half-closed connection whose native handle disappears', async () => {
    const { port, tunnel } = startStalledServer();
    const client = startClient(port);
    const fx = await tunnel;
    await new Promise<void>((done) => client.write('hi', () => done()));
    const handle = socketHandle(client);
    expect(handle && shutdownWriteHalf(handle)).toBe(true);
    await Bun.sleep(80);
    // 对端已经 FIN 过一次，流也 END 过；此时再 RST，Bun 不会给第二次 end，onClose 也会被挡掉
    (fx.socket as unknown as { _handle: unknown })._handle = null;
    expect(fx.disposed()).toBe(false);
    scanSocketLiveness();
    expect(fx.disposed()).toBe(true);
    expect(fx.socket.destroyed).toBe(true);
    expect((await fx.remote.closed).reason).toBe('rst');
  });

  test('the shared poller reclaims a dead connection without an explicit scan', async () => {
    const { port, tunnel } = startStalledServer();
    const client = startClient(port);
    const fx = await tunnel;
    client.write(new Uint8Array(8 * 1024 * 1024));
    await Bun.sleep(200);
    expect(abortSocket(client)).toBe(true);
    await Bun.sleep(1_500);
    expect(fx.disposed()).toBe(true);
    expect(fx.socket.destroyed).toBe(true);
  }, 15_000);

  test('stops watching a socket once it closes', async () => {
    const before = watchedSocketCount();
    const { port, tunnel } = startStalledServer();
    startClient(port);
    const fx = await tunnel;
    expect(watchedSocketCount()).toBe(before + 1);
    fx.remote.reset('test-abort');
    await Bun.sleep(80);
    expect(fx.socket.destroyed).toBe(true);
    expect(fx.disposed()).toBe(true);
    expect(watchedSocketCount()).toBe(before);
  });
});
