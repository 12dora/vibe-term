import { describe, expect, test } from 'bun:test';
import type { LinkStream, StreamChunk, StreamCloseInfo } from '@tmex/shared/link';
import { pumpHubRelay } from './hub-relay-pump';

const never = <T>(): Promise<T> => new Promise<T>(() => {});

class PumpStream implements LinkStream {
  readonly id = 1;
  readonly openPayload = new Uint8Array();
  readonly closed = never<StreamCloseInfo>();
  private readonly abortHandlers: Array<() => void> = [];
  private aborted = false;

  constructor(
    readonly readable: ReadableStream<StreamChunk>,
    private readonly name: string,
    private readonly events: string[],
    private readonly writeFails = false,
    private readonly endFails = false
  ) {}

  write(): Promise<void> {
    this.events.push(`${this.name}:write`);
    return this.writeFails ? Promise.reject(new Error('write failed')) : Promise.resolve();
  }

  end(): Promise<void> {
    this.events.push(`${this.name}:end`);
    return this.endFails ? Promise.reject(new Error('end failed')) : Promise.resolve();
  }

  reset(reason?: string): void {
    this.events.push(`${this.name}:reset:${reason ?? ''}`);
    this.abort();
  }

  onAbort(cb: () => void): void {
    if (this.aborted) cb();
    else this.abortHandlers.push(cb);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const handler of this.abortHandlers) handler();
  }
}

function pendingReadable(): ReadableStream<StreamChunk> {
  return new ReadableStream({ pull: () => never<void>() });
}

function errorReadable(): ReadableStream<StreamChunk> {
  return new ReadableStream({ start: (controller) => controller.error(new Error('read failed')) });
}

function oneChunkReadable(): ReadableStream<StreamChunk> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return never<void>();
      sent = true;
      controller.enqueue({ bytes: new Uint8Array([1]), head: false });
    },
  });
}

async function settle(events: string[]): Promise<void> {
  for (let i = 0; i < 20 && !events.some((event) => event.includes(':reset:')); i++) {
    await Promise.resolve();
  }
}

describe('hub relay pump', () => {
  test('reports a source read failure after half-close fails', async () => {
    const events: string[] = [];
    const source = new PumpStream(errorReadable(), 'src', events);
    const destination = new PumpStream(pendingReadable(), 'dst', events, false, true);
    pumpHubRelay(source, destination);
    await settle(events);
    expect(events).toEqual([
      'dst:end',
      'src:reset:relay-rst:src-read',
      'dst:reset:relay-rst:src-read',
    ]);
  });

  test('reports a destination write failure after half-close fails', async () => {
    const events: string[] = [];
    const source = new PumpStream(oneChunkReadable(), 'src', events);
    const destination = new PumpStream(pendingReadable(), 'dst', events, true, true);
    pumpHubRelay(source, destination);
    await settle(events);
    expect(events).toEqual([
      'dst:write',
      'dst:end',
      'src:reset:relay-rst:dst-write',
      'dst:reset:relay-rst:dst-write',
    ]);
  });

  test('keeps the opposite direction open when half-close succeeds', async () => {
    const events: string[] = [];
    pumpHubRelay(
      new PumpStream(errorReadable(), 'src', events),
      new PumpStream(pendingReadable(), 'dst', events)
    );
    await settle(events);
    expect(events).toEqual(['dst:end']);
  });

  test('propagates peer abort with a prefix-compatible reason', async () => {
    const events: string[] = [];
    const source = new PumpStream(pendingReadable(), 'src', events);
    const destination = new PumpStream(pendingReadable(), 'dst', events);
    pumpHubRelay(source, destination);
    source.abort();
    expect(events).toEqual(['src:reset:relay-rst:peer-abort', 'dst:reset:relay-rst:peer-abort']);
  });
});
