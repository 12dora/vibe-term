import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import { type LinkStream, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { encodeJsonBytes } from '../mesh/ctl';
import { dialTcp } from './dial';
import { type PumpSocket, TcpStreamPump, attachPump, createPumpSocketData } from './pump';
import {
  attachPumpSocketHandlers,
  destroySocket,
  netPumpSocket,
  prepareSocket,
} from './socket-handlers';
import {
  type EchoServer,
  startAfterFinServer,
  startEchoServer,
  startFinServer,
} from './test-echo-server';
import { type PortMapCounters, createPortMapCounters } from './types';

type Fixture = {
  remote: LinkStream;
  socket: Socket;
  counters: PortMapCounters;
  pump: TcpStreamPump;
};

const cleanups: Array<() => void> = [];

function fakeSocket(calls: string[] = []): PumpSocket {
  return {
    write: () => true,
    endWrite: () => calls.push('endWrite'),
    close: () => calls.push('close'),
    terminate: () => calls.push('terminate'),
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
  };
}

async function connectPump(port: number): Promise<Fixture> {
  const [linkA, linkB] = createInMemoryLinkPair();
  const remoteReady = new Promise<LinkStream>((resolve) => linkB.onStream(resolve));
  const local = await linkA.openStream(
    encodeJsonBytes({ type: 'tcp', mapId: 'm', host: '127.0.0.1', port })
  );
  const remote = await remoteReady;
  const data = createPumpSocketData();
  const socket = await dialTcp({ host: '127.0.0.1', port }, 2_000).result;
  prepareSocket(socket);
  attachPumpSocketHandlers(socket, data);
  const counters = createPortMapCounters();
  const pump = new TcpStreamPump(netPumpSocket(socket), local, counters);
  attachPump(data, pump);
  cleanups.push(() => {
    destroySocket(socket);
    linkA.close('test-done');
    linkB.close('test-done');
  });
  return { remote, socket, counters, pump };
}

async function readExactly(stream: LinkStream, total: number): Promise<Uint8Array> {
  const out = new Uint8Array(total);
  let offset = 0;
  const reader = stream.readable.getReader();
  try {
    while (offset < total) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended after ${offset} of ${total} bytes`);
      const bytes = value?.bytes;
      if (!bytes) continue;
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

describe('portmap pump', () => {
  let echo: EchoServer | null = null;

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    echo?.stop();
    echo = null;
  });

  test('round-trips bytes between the link stream and the socket', async () => {
    echo = startEchoServer();
    const fx = await connectPump(echo.port);
    await fx.remote.write(new TextEncoder().encode('hello portmap'));
    const back = await readExactly(fx.remote, 13);
    expect(new TextDecoder().decode(back)).toBe('hello portmap');
    await Bun.sleep(20);
    expect(fx.counters.bytesIn).toBe(13);
    expect(fx.counters.bytesOut).toBe(13);
  });

  test('carries a payload larger than the mux window', async () => {
    echo = startEchoServer();
    const fx = await connectPump(echo.port);
    const size = 1024 * 1024 + 4096;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;
    const received = readExactly(fx.remote, size);
    await fx.remote.write(payload);
    const back = await received;
    expect(back.byteLength).toBe(size);
    expect(back[0]).toBe(0);
    expect(back[size - 1]).toBe((size - 1) & 0xff);
    await Bun.sleep(50);
    expect(fx.counters.bytesIn).toBe(size);
    expect(fx.counters.bytesOut).toBe(size);
  });

  test('turns a socket FIN into a stream END', async () => {
    echo = startFinServer(new TextEncoder().encode('done'));
    const fx = await connectPump(echo.port);
    const reader = fx.remote.readable.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value?.bytes)).toBe('done');
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    await fx.remote.end();
    const info = await fx.remote.closed;
    expect(info.reason).toBe('end');
  });

  test('turns a stream END into a socket close and finishes cleanly', async () => {
    echo = startEchoServer();
    const fx = await connectPump(echo.port);
    await fx.remote.write(new TextEncoder().encode('bye'));
    await readExactly(fx.remote, 3);
    await fx.remote.end();
    const info = await fx.remote.closed;
    expect(info.reason).toBe('end');
    await Bun.sleep(80);
    expect(fx.socket.destroyed).toBe(true);
  });

  test('keeps the read half after a stream END so a reply produced on EOF still arrives', async () => {
    const server = startAfterFinServer(new TextEncoder().encode('reply-after-fin'));
    echo = server;
    const fx = await connectPump(server.port);
    await fx.remote.write(new TextEncoder().encode('request'));
    // 对端 END：泵只该关掉本地 socket 的写半边，目标要在读到 EOF 之后才回复
    await fx.remote.end();
    const back = await readExactly(fx.remote, 15);
    expect(new TextDecoder().decode(back)).toBe('reply-after-fin');
    expect(server.received()).toBe(7);
    await Bun.sleep(20);
    expect(fx.counters.bytesIn).toBe(7);
    expect(fx.counters.bytesOut).toBe(15);
  });

  test('resetting the stream terminates the socket', async () => {
    echo = startEchoServer();
    const fx = await connectPump(echo.port);
    await fx.remote.write(new TextEncoder().encode('x'));
    await readExactly(fx.remote, 1);
    fx.remote.reset('test-abort');
    await Bun.sleep(50);
    expect(fx.socket.destroyed).toBe(true);
  });

  test('closing the socket resets the stream', async () => {
    echo = startEchoServer();
    const fx = await connectPump(echo.port);
    destroySocket(fx.socket);
    const info = await fx.remote.closed;
    expect(info.reason).toBe('rst');
  });

  test('a socket that closes without a FIN resets the stream', async () => {
    const [linkA, linkB] = createInMemoryLinkPair();
    cleanups.push(() => {
      linkA.close('test-done');
      linkB.close('test-done');
    });
    const remoteReady = new Promise<LinkStream>((resolve) => linkB.onStream(resolve));
    const local = await linkA.openStream(encodeJsonBytes({ type: 'tcp' }));
    const remote = await remoteReady;
    const pump = new TcpStreamPump(fakeSocket(), local, createPortMapCounters());
    pump.start();
    pump.onClose();
    const info = await remote.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toContain('portmap-socket-closed');
  });

  test('stops reading above the high water mark and resumes below the low one', async () => {
    const [linkA, linkB] = createInMemoryLinkPair();
    cleanups.push(() => {
      linkA.close('test-done');
      linkB.close('test-done');
    });
    const remoteReady = new Promise<LinkStream>((resolve) => linkB.onStream(resolve));
    const local = await linkA.openStream(encodeJsonBytes({ type: 'tcp' }));
    const remote = await remoteReady;
    const calls: string[] = [];
    const pump = new TcpStreamPump(fakeSocket(calls), local, createPortMapCounters());
    pump.start();
    // 对端一个字节都不读：写满 1 MiB 窗口之后 stream.write 就挂住，pending 越过高水位必须停读
    for (let i = 0; i < 48; i += 1) pump.onData(new Uint8Array(64 * 1024));
    expect(calls).toContain('pause');
    const reader = remote.readable.getReader();
    let read = 0;
    while (read < 48 * 64 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value?.bytes.byteLength ?? 0;
    }
    reader.releaseLock();
    await Bun.sleep(50);
    expect(calls).toContain('resume');
    expect(read).toBe(48 * 64 * 1024);
  });

  test('waits for drain before pulling the next chunk from the stream', async () => {
    const [linkA, linkB] = createInMemoryLinkPair();
    cleanups.push(() => {
      linkA.close('test-done');
      linkB.close('test-done');
    });
    const remoteReady = new Promise<LinkStream>((resolve) => linkB.onStream(resolve));
    const local = await linkA.openStream(encodeJsonBytes({ type: 'tcp' }));
    const remote = await remoteReady;
    const counters = createPortMapCounters();
    let accepted = 0;
    const socket: PumpSocket = {
      ...fakeSocket(),
      write(data) {
        accepted += data.byteLength;
        return false;
      },
    };
    const pump = new TcpStreamPump(socket, local, counters);
    pump.start();
    for (let i = 0; i < 8; i += 1) await remote.write(new Uint8Array(64 * 1024));
    await Bun.sleep(30);
    // 第一块之后就在等 drain，绝不能把整条流吞进内存
    expect(accepted).toBe(64 * 1024);
    pump.onDrain();
    await Bun.sleep(30);
    expect(accepted).toBe(2 * 64 * 1024);
  });
});
