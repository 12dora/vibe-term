import { afterEach, describe, expect, test } from 'bun:test';
import { type LinkSession, type LinkStream, createInMemoryLinkPair } from '@tmex/shared/link';
import { encodeJsonBytes } from '../mesh/ctl';
import { acceptTcpStream } from './accept-tcp-stream';
import { peerStreamSlotsInUse, resetPeerStreamSlots } from './budget';
import { MemoryPortMapExportStore } from './store';
import { type EchoServer, startEchoServer } from './test-echo-server';
import type { PortMapExportRow } from './types';

const PEER = 'a'.repeat(32);
const OTHER_PEER = 'b'.repeat(32);
const MAP_ID = 'map-000000001';

const links: LinkSession[] = [];

function exportRow(port: number, patch: Partial<PortMapExportRow> = {}): PortMapExportRow {
  return {
    mapId: MAP_ID,
    fromNodeId: PEER,
    host: '127.0.0.1',
    port,
    enabled: true,
    createdAt: 1,
    ...patch,
  };
}

async function openTcpStream(
  exports: MemoryPortMapExportStore,
  payload: Record<string, unknown>,
  peerNodeId = PEER,
  peerStreamLimit?: number
): Promise<LinkStream> {
  const [linkA, linkB] = createInMemoryLinkPair();
  links.push(linkA, linkB);
  linkB.onStream((stream) => {
    void acceptTcpStream(stream, {
      peerNodeId,
      exports,
      connectTimeoutMs: 500,
      ...(peerStreamLimit === undefined ? {} : { peerStreamLimit }),
    });
  });
  return linkA.openStream(encodeJsonBytes(payload));
}

describe('portmap acceptTcpStream', () => {
  let echo: EchoServer | null = null;

  afterEach(() => {
    while (links.length > 0) links.pop()?.close('test-done');
    echo?.stop();
    echo = null;
    resetPeerStreamSlots();
  });

  test('dials the exported target and pumps bytes', async () => {
    echo = startEchoServer();
    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(echo.port));
    const stream = await openTcpStream(exports, {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: echo.port,
    });
    await stream.write(new TextEncoder().encode('ping'));
    const reader = stream.readable.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value?.bytes)).toBe('ping');
    reader.releaseLock();
    expect(echo.connections).toBe(1);
  });

  test('rejects an unknown map id', async () => {
    echo = startEchoServer();
    const stream = await openTcpStream(new MemoryPortMapExportStore(), {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: echo.port,
    });
    const info = await stream.closed;
    expect(info.reason).toBe('rst');
    expect(info.message).toContain('portmap-forbidden');
    expect(echo.connections).toBe(0);
  });

  test('rejects a peer that does not own the export', async () => {
    echo = startEchoServer();
    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(echo.port));
    const stream = await openTcpStream(
      exports,
      { type: 'tcp', mapId: MAP_ID, host: '127.0.0.1', port: echo.port },
      OTHER_PEER
    );
    const info = await stream.closed;
    expect(info.message).toContain('portmap-forbidden');
    expect(echo.connections).toBe(0);
  });

  test('rejects a disabled export and a host or port mismatch', async () => {
    echo = startEchoServer();
    const disabled = new MemoryPortMapExportStore();
    disabled.insert(exportRow(echo.port, { enabled: false }));
    const first = await openTcpStream(disabled, {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: echo.port,
    });
    expect((await first.closed).message).toContain('portmap-forbidden');

    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(echo.port));
    const second = await openTcpStream(exports, {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: echo.port + 1,
    });
    expect((await second.closed).message).toContain('portmap-forbidden');
    expect(echo.connections).toBe(0);
  });

  test('rejects a malformed payload', async () => {
    const stream = await openTcpStream(new MemoryPortMapExportStore(), {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: 0,
    });
    expect((await stream.closed).message).toContain('portmap-invalid-payload');
  });

  test('resets when the target port is not listening', async () => {
    const closed = startEchoServer();
    const port = closed.port;
    closed.stop();
    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(port));
    const stream = await openTcpStream(exports, {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port,
    });
    expect((await stream.closed).message).toContain('portmap-connect-failed');
  });

  test('refuses a stream once the peer link budget is used up', async () => {
    echo = startEchoServer();
    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(echo.port));
    const payload = { type: 'tcp', mapId: MAP_ID, host: '127.0.0.1', port: echo.port };
    const first = await openTcpStream(exports, payload, PEER, 1);
    await first.write(new TextEncoder().encode('a'));
    const reader = first.readable.getReader();
    await reader.read();
    reader.releaseLock();
    expect(peerStreamSlotsInUse(PEER)).toBe(1);
    const second = await openTcpStream(exports, payload, PEER, 1);
    expect((await second.closed).message).toContain('portmap-peer-limit');
    expect(echo.connections).toBe(1);
  });

  test('gives the peer slot back when the target socket goes away', async () => {
    echo = startEchoServer();
    const exports = new MemoryPortMapExportStore();
    exports.insert(exportRow(echo.port));
    const stream = await openTcpStream(exports, {
      type: 'tcp',
      mapId: MAP_ID,
      host: '127.0.0.1',
      port: echo.port,
    });
    await stream.write(new TextEncoder().encode('a'));
    const reader = stream.readable.getReader();
    await reader.read();
    reader.releaseLock();
    expect(peerStreamSlotsInUse(PEER)).toBe(1);
    stream.reset('test-abort');
    await Bun.sleep(50);
    expect(peerStreamSlotsInUse(PEER)).toBe(0);
  });
});
