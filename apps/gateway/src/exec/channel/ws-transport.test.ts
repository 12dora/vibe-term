import { describe, expect, test } from 'bun:test';
import type { ExecChannelInbound } from './transport-types';
import {
  EXEC_WS_DRAIN_BYTES,
  ExecWsConnection,
  type ExecWsSocket,
  truncateCloseReason,
} from './ws-transport';

class FakeSocket implements ExecWsSocket {
  sent: Uint8Array[] = [];
  buffered = 0;
  closes: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;
  throwOnClose = false;

  sendBinary(data: Uint8Array): number {
    if (this.throwOnSend) throw new Error('closed');
    this.sent.push(data);
    return data.byteLength;
  }

  getBufferedAmount(): number {
    return this.buffered;
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) throw new Error('already closed');
    this.closes.push({ code, reason });
  }
}

function setup() {
  const ws = new FakeSocket();
  const conn = new ExecWsConnection(ws);
  const chunks: Uint8Array[] = [];
  let closed = 0;
  const inbound: ExecChannelInbound = {
    onBytes: (chunk) => chunks.push(chunk),
    onClose: () => {
      closed += 1;
    },
  };
  conn.attach(inbound);
  return { ws, conn, chunks, closedCount: () => closed };
}

describe('ExecWsConnection', () => {
  test('send writes binary frames and reports buffered bytes', () => {
    const { ws, conn } = setup();
    ws.buffered = 777;
    conn.send(Uint8Array.of(1, 2, 3));
    expect(ws.sent).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(conn.bufferedBytes).toBe(777);
  });

  test('send never throws on a dead socket and is dropped after close()', () => {
    const { ws, conn } = setup();
    ws.throwOnSend = true;
    expect(() => conn.send(Uint8Array.of(1))).not.toThrow();
    ws.throwOnSend = false;
    conn.close(1000, 'bye');
    conn.send(Uint8Array.of(2));
    expect(ws.sent).toEqual([]);
  });

  test('binary messages go to onBytes without copying, ArrayBuffer is accepted', () => {
    const { conn, chunks } = setup();
    const source = Buffer.from([9, 8, 7]);
    conn.handleMessage(source);
    conn.handleMessage(Uint8Array.of(1, 2).buffer);
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0] as Uint8Array)).toEqual([9, 8, 7]);
    expect(chunks[0]?.buffer).toBe(source.buffer);
    expect(Array.from(chunks[1] as Uint8Array)).toEqual([1, 2]);
  });

  test('a text message closes with 4400 and later input is ignored', () => {
    const { ws, conn, chunks } = setup();
    conn.handleMessage('hello');
    expect(ws.closes).toEqual([{ code: 4400, reason: 'binary frames only' }]);
    conn.handleMessage(Uint8Array.of(1));
    expect(chunks).toEqual([]);
  });

  test('close is guarded against double calls', () => {
    const { ws, conn } = setup();
    conn.close(4409, 'taken over');
    conn.close(1000, 'again');
    expect(ws.closes).toEqual([{ code: 4409, reason: 'taken over' }]);
  });

  test('a close() on an already closed socket still notifies the session once', () => {
    const { ws, conn, closedCount } = setup();
    ws.throwOnClose = true;
    conn.close(1000, 'x');
    expect(closedCount()).toBe(1);
    conn.handleClose();
    expect(closedCount()).toBe(1);
  });

  test('handleClose notifies the session exactly once', () => {
    const { conn, closedCount } = setup();
    conn.handleClose();
    conn.handleClose();
    expect(closedCount()).toBe(1);
  });

  test('drain callbacks fire only below the drain threshold', () => {
    const { ws, conn } = setup();
    let drained = 0;
    conn.onDrain(() => {
      drained += 1;
    });
    ws.buffered = EXEC_WS_DRAIN_BYTES;
    conn.handleDrain();
    expect(drained).toBe(0);
    ws.buffered = EXEC_WS_DRAIN_BYTES - 1;
    conn.handleDrain();
    expect(drained).toBe(1);
  });

  test('a throwing drain callback does not break the others', () => {
    const { conn } = setup();
    let ran = false;
    conn.onDrain(() => {
      throw new Error('boom');
    });
    conn.onDrain(() => {
      ran = true;
    });
    conn.handleDrain();
    expect(ran).toBe(true);
  });
});

describe('truncateCloseReason', () => {
  test('keeps short reasons and cuts long ones on a character boundary within 123 bytes', () => {
    expect(truncateCloseReason('ok')).toBe('ok');
    const long = '会'.repeat(60);
    const cut = truncateCloseReason(long);
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(123);
    expect(cut).toBe('会'.repeat(41));
    expect(truncateCloseReason('a'.repeat(300))).toBe('a'.repeat(123));
  });
});
