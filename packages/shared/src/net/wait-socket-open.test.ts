import { describe, expect, test } from 'bun:test';

import { socketCloseError, socketErrorEvent, waitSocketOpen } from './wait-socket-open';

type SocketEvent = Event | { code?: number; reason?: string; error?: unknown; message?: string };

class FakeSocket {
  readyState = 0;
  closed: { code: number; reason: string } | null = null;
  private readonly listeners = new Map<string, Array<(ev: SocketEvent) => void>>();

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(code = 1000, reason = ''): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', new Event('open'));
  }

  fail(ev: SocketEvent): void {
    this.emit('error', ev);
  }

  private emit(type: string, ev: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

describe('waitSocketOpen', () => {
  test('resolves immediately when the socket is already open', async () => {
    const ws = new FakeSocket();
    ws.readyState = 1;
    await waitSocketOpen(ws, 50);
  });

  test('resolves immediately for a server-socket adapter', async () => {
    const adapter = {
      onDrain() {},
      onMessage() {},
      close() {},
    };
    await waitSocketOpen(adapter, 50);
  });

  test('resolves when open fires', async () => {
    const ws = new FakeSocket();
    const pending = waitSocketOpen(ws, 1_000);
    ws.open();
    await pending;
  });

  test('rejects with connect-timeout and closes the socket', async () => {
    const ws = new FakeSocket();
    const pending = waitSocketOpen(ws, 20);
    await expect(pending).rejects.toThrow('connect-timeout');
    expect(ws.closed).toEqual({ code: 1000, reason: 'connect-timeout' });
  });

  test('abort uses signal.reason and abortCloseReason', async () => {
    const ws = new FakeSocket();
    const ac = new AbortController();
    const pending = waitSocketOpen(ws, 5_000, ac.signal, 'stopped');
    ac.abort(new Error('dial-timeout'));
    await expect(pending).rejects.toThrow('dial-timeout');
    expect(ws.closed).toEqual({ code: 1000, reason: 'stopped' });
  });

  test('already-aborted signal rejects without waiting', async () => {
    const ws = new FakeSocket();
    const ac = new AbortController();
    ac.abort();
    await expect(waitSocketOpen(ws, 5_000, ac.signal)).rejects.toThrow('aborted');
    expect(ws.closed).toEqual({ code: 1000, reason: 'aborted' });
  });

  test('close carries code for uplink http classification', async () => {
    const ws = new FakeSocket();
    const pending = waitSocketOpen(ws, 1_000);
    ws.close(4401, 'login required');
    await expect(pending).rejects.toMatchObject({
      message: 'ws-closed 4401 login required',
      closeCode: 4401,
    });
  });

  test('error event rejects with the inner error', async () => {
    const ws = new FakeSocket();
    const pending = waitSocketOpen(ws, 1_000);
    ws.fail({ error: new Error('tls handshake failed') });
    await expect(pending).rejects.toThrow('tls handshake failed');
  });
});

describe('socket close/error helpers', () => {
  test('socketCloseError strips control characters from the reason', () => {
    const err = socketCloseError({ code: 1006, reason: 'bad\nframe' });
    expect(err.message).toBe('ws-closed 1006 badframe');
    expect((err as Error & { closeCode: number }).closeCode).toBe(1006);
  });

  test('socketErrorEvent falls back to ws-error', () => {
    expect(socketErrorEvent({}).message).toBe('ws-error');
    expect(socketErrorEvent({ message: 'boom' }).message).toBe('boom');
  });
});
