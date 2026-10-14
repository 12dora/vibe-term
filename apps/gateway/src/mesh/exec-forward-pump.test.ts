import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import { FakeLinkStream } from '../exec/channel/test-link-stream';
import {
  EXEC_FORWARD_QUEUE_MAX_BYTES,
  EXEC_FORWARD_WS_HIGH_WATER,
  ExecForwardPump,
  type ExecForwardSocket,
  execForwardCloseFor,
} from './exec-forward-pump';
import { waitUntil } from './test-support';

class FakeWs implements ExecForwardSocket {
  readonly sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  buffered = 0;
  sendResult: number | undefined = 1;

  send(data: Uint8Array): number | undefined {
    if (this.closed) return 0;
    this.sent.push(data);
    return this.sendResult;
  }

  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }

  getBufferedAmount(): number {
    return this.buffered;
  }
}

const bytes = (...values: number[]) => new Uint8Array(values);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function boot() {
  const ws = new FakeWs();
  const stream = new FakeLinkStream();
  const pump = new ExecForwardPump(async () => stream);
  pump.open(ws);
  return { ws, stream, pump };
}

describe('ExecForwardPump upstream', () => {
  test('messages sent before the stream opens are written in order afterwards', async () => {
    const ws = new FakeWs();
    const stream = new FakeLinkStream();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pump = new ExecForwardPump(async () => {
      await gate;
      return stream;
    });
    pump.open(ws);
    pump.onMessage(bytes(1));
    pump.onMessage(bytes(2).buffer);
    pump.onMessage(bytes(3));
    expect(stream.written).toHaveLength(0);
    release();
    await waitUntil(() => stream.written.length === 3);
    expect(stream.written.map((chunk) => chunk[0])).toEqual([1, 2, 3]);
  });

  test('writes are sequential and wait for the stream to accept the previous one', async () => {
    const { stream, pump } = boot();
    await tick();
    stream.blockWrites();
    pump.onMessage(bytes(1));
    pump.onMessage(bytes(2));
    await tick();
    expect(stream.written).toHaveLength(0);
    stream.releaseWrites();
    await waitUntil(() => stream.written.length === 2);
    expect(stream.written.map((chunk) => chunk[0])).toEqual([1, 2]);
  });

  test('queue above 16 MiB closes the websocket with 1009 and resets the stream', async () => {
    const { ws, stream, pump } = boot();
    await tick();
    stream.blockWrites();
    const mib = new Uint8Array(1024 * 1024);
    for (let sent = 0; sent < EXEC_FORWARD_QUEUE_MAX_BYTES; sent += mib.byteLength) {
      pump.onMessage(mib);
    }
    expect(ws.closed).toBeNull();
    pump.onMessage(bytes(1));
    expect(ws.closed?.code).toBe(1009);
    expect(stream.dead).toBe(true);
  });

  test('queue cap also applies before the stream is open', () => {
    const ws = new FakeWs();
    const pump = new ExecForwardPump(() => new Promise<LinkStream>(() => {}));
    pump.open(ws);
    const mib = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 16; i += 1) pump.onMessage(mib);
    expect(ws.closed).toBeNull();
    pump.onMessage(mib);
    expect(ws.closed?.code).toBe(1009);
  });

  test('text messages close with 4400', async () => {
    const { ws, stream, pump } = boot();
    await tick();
    pump.onMessage('hello');
    expect(ws.closed).toEqual({ code: 4400, reason: 'binary_required' });
    expect(stream.dead).toBe(true);
  });

  test('client close resets the stream with client-closed', async () => {
    const { ws, stream, pump } = boot();
    await tick();
    pump.onClose();
    expect(stream.resetReason).toBe('client-closed');
    expect(ws.closed).toBeNull();
    pump.onMessage(bytes(1));
    expect(stream.written).toHaveLength(0);
  });

  test('client close before the stream opens resets it once it arrives', async () => {
    const ws = new FakeWs();
    const stream = new FakeLinkStream();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pump = new ExecForwardPump(async () => {
      await gate;
      return stream;
    });
    pump.open(ws);
    pump.onClose();
    release();
    await waitUntil(() => stream.dead);
    expect(stream.resetReason).toBe('client-closed');
  });
});

describe('ExecForwardPump downstream', () => {
  test('stream bytes reach the websocket in order', async () => {
    const { ws, stream } = boot();
    stream.push(bytes(1, 1));
    stream.push(bytes(2));
    stream.push(bytes(3));
    await waitUntil(() => ws.sent.length === 3);
    expect(ws.sent.map((chunk) => chunk[0])).toEqual([1, 2, 3]);
  });

  test('stops pulling while the websocket buffer is above 1 MiB and resumes on drain', async () => {
    const { ws, stream, pump } = boot();
    ws.buffered = EXEC_FORWARD_WS_HIGH_WATER + 1;
    stream.push(bytes(1));
    stream.push(bytes(2));
    await tick();
    expect(stream.pulled).toBe(0);
    expect(ws.sent).toHaveLength(0);
    ws.buffered = 0;
    pump.onDrain();
    await waitUntil(() => ws.sent.length === 2);
    expect(stream.pulled).toBe(2);
  });

  test('drain without a getBufferedAmount reading uses the send backpressure signal', async () => {
    const ws = new FakeWs();
    (ws as { getBufferedAmount?: unknown }).getBufferedAmount = undefined;
    const stream = new FakeLinkStream();
    const pump = new ExecForwardPump(async () => stream);
    pump.open(ws);
    ws.sendResult = -1;
    stream.push(bytes(1));
    stream.push(bytes(2));
    await waitUntil(() => ws.sent.length === 1);
    await tick();
    expect(ws.sent).toHaveLength(1);
    pump.onDrain();
    await waitUntil(() => ws.sent.length === 2);
  });

  test('a dropped send (socket gone) resets the stream', async () => {
    const { ws, stream } = boot();
    ws.sendResult = 0;
    stream.push(bytes(1));
    await waitUntil(() => stream.dead);
    expect(stream.resetReason).toBe('client-closed');
  });
});

describe('ExecForwardPump close mapping', () => {
  test('stream END closes 1000 and ends our side', async () => {
    const { ws, stream } = boot();
    stream.push(bytes(9));
    stream.peerEnd();
    await waitUntil(() => ws.closed !== null);
    expect(ws.sent).toHaveLength(1);
    expect(ws.closed).toEqual({ code: 1000, reason: 'exec_end' });
    expect(stream.ended).toBe(true);
  });

  test('unknown-stream-type RST -> 4404 exec_unsupported', async () => {
    const { ws, stream } = boot();
    stream.peerReset('unknown-stream-type');
    await waitUntil(() => ws.closed !== null);
    expect(ws.closed).toEqual({ code: 4404, reason: 'exec_unsupported' });
  });

  test('auth: RST -> 4401 NODE_LOGIN_REQUIRED', async () => {
    const { ws, stream } = boot();
    stream.peerReset('auth:expired');
    await waitUntil(() => ws.closed !== null);
    expect(ws.closed).toEqual({ code: 4401, reason: 'NODE_LOGIN_REQUIRED' });
  });

  test('other RST and link loss -> 4502 NODE_UNREACHABLE', async () => {
    const first = boot();
    first.stream.peerReset('portmap-forbidden');
    await waitUntil(() => first.ws.closed !== null);
    expect(first.ws.closed).toEqual({ code: 4502, reason: 'NODE_UNREACHABLE' });
    const second = boot();
    second.stream.linkLost();
    await waitUntil(() => second.ws.closed !== null);
    expect(second.ws.closed).toEqual({ code: 4502, reason: 'NODE_UNREACHABLE' });
  });

  test('RST while uploads are blocked still closes the websocket', async () => {
    const { ws, stream, pump } = boot();
    await tick();
    stream.blockWrites();
    pump.onMessage(bytes(1));
    ws.buffered = EXEC_FORWARD_WS_HIGH_WATER + 1;
    stream.peerReset('auth:revoked');
    await waitUntil(() => ws.closed !== null);
    expect(ws.closed?.code).toBe(4401);
  });

  test('link acquisition failure -> 4502 NODE_UNREACHABLE', async () => {
    const ws = new FakeWs();
    const pump = new ExecForwardPump(async () => {
      throw new Error('forward-link-timeout');
    });
    pump.open(ws);
    await waitUntil(() => ws.closed !== null);
    expect(ws.closed).toEqual({ code: 4502, reason: 'NODE_UNREACHABLE' });
  });

  test('execForwardCloseFor passes target close codes through', () => {
    expect(execForwardCloseFor({ reason: 'rst', message: 'exec:4409' }).code).toBe(4409);
    expect(execForwardCloseFor({ reason: 'rst', message: 'exec:4403' }).code).toBe(4403);
    expect(execForwardCloseFor({ reason: 'rst', message: 'exec:1011' }).code).toBe(4502);
    expect(execForwardCloseFor({ reason: 'rst' }).code).toBe(4502);
  });
});
