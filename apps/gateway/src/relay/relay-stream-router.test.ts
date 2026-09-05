import { describe, expect, test } from 'bun:test';
import type {
  LinkCloseInfo,
  LinkSession,
  LinkStream,
  StreamChunk,
  StreamCloseInfo,
  WriteOptions,
} from '@tmex/shared/link';
import { encodeRelayOpenStream } from '@tmex/shared/relay';
import { RelayMetering } from './relay-metering';
import { RelayTokenBucket } from './relay-quota';
import { RelayRegistry } from './relay-registry';
import { type RelayStreamContext, acceptRelayStream } from './relay-stream-router';
import type { RelayTenantStore } from './relay-tenant-store';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const SOURCE_ID = 'a'.repeat(32);
const TARGET_ID = 'b'.repeat(32);

class TestStream implements LinkStream {
  readonly id = 1;
  readonly closed = never<StreamCloseInfo>();
  private readonly abortHandlers: Array<() => void> = [];
  private aborted = false;

  constructor(
    readonly openPayload: Uint8Array,
    readonly readable: ReadableStream<StreamChunk>,
    private readonly name: string,
    private readonly events: string[],
    private readonly writeFails = false,
    private readonly endFails = false
  ) {}

  write(_bytes: Uint8Array, _opts?: WriteOptions): Promise<void> {
    this.events.push(`${this.name}:write`);
    return this.writeFails ? Promise.reject(new Error('write failed')) : Promise.resolve();
  }

  end(): Promise<void> {
    this.events.push(`${this.name}:end`);
    return this.endFails ? Promise.reject(new Error('end failed')) : Promise.resolve();
  }

  reset(reason?: string): void {
    this.events.push(`${this.name}:reset:${reason ?? ''}`);
    if (this.aborted) return;
    this.aborted = true;
    for (const handler of this.abortHandlers) handler();
  }

  onAbort(cb: () => void): void {
    if (this.aborted) cb();
    else this.abortHandlers.push(cb);
  }
}

function session(openStream?: () => Promise<LinkStream>): LinkSession {
  return {
    openStream: openStream ?? (() => Promise.reject(new Error('unexpected open'))),
    onStream() {},
    ctl: { send() {}, onMessage() {} },
    close() {},
    closed: never<LinkCloseInfo>(),
  };
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

async function runFailure(
  source: ReadableStream<StreamChunk>,
  writeFails: boolean,
  endFails: boolean
) {
  const events: string[] = [];
  const outbound = new TestStream(
    new Uint8Array(),
    pendingReadable(),
    'dst',
    events,
    writeFails,
    endFails
  );
  const registry = new RelayRegistry();
  const sourceLink = session();
  const targetLink = session(() => Promise.resolve(outbound));
  const sourceLive = registry.put({
    tenantId: 'tenant',
    nodeId: SOURCE_ID,
    link: sourceLink,
    tokenEpoch: 1,
    tokenHash: 'hash',
    protoVersion: 1,
    clientVersion: '1.1.30',
  }).live;
  registry.put({
    tenantId: 'tenant',
    nodeId: TARGET_ID,
    link: targetLink,
    tokenEpoch: 1,
    tokenHash: 'hash',
    protoVersion: 1,
    clientVersion: '1.1.30',
  });
  const incoming = new TestStream(encodeRelayOpenStream({ to: TARGET_ID }), source, 'src', events);
  const metering = new RelayMetering({} as RelayTenantStore, () => 100, 0);
  const bucket = new RelayTokenBucket(null);
  const context: RelayStreamContext = {
    registry,
    tenants: { getNode: () => ({ status: 'admitted' }) } as unknown as RelayTenantStore,
    metering,
    quotaFor: () => ({ maxNodes: 2, maxStreams: 2, bandwidthBytesPerSec: null }),
    bucketFor: () => bucket,
    now: () => 100,
    isStopped: () => false,
  };
  await acceptRelayStream(context, sourceLive, incoming);
  for (let i = 0; i < 20 && !events.some((event) => event.startsWith('src:reset:')); i++) {
    await Promise.resolve();
  }
  return events;
}

describe('relay stream directional failures', () => {
  test('half-closes the destination before resetting a source read failure', async () => {
    const events = await runFailure(errorReadable(), false, true);
    expect(events).toEqual([
      'dst:end',
      'src:reset:relay-rst:src-read',
      'dst:reset:relay-rst:src-read',
    ]);
  });

  test('half-closes the destination before resetting a destination write failure', async () => {
    const events = await runFailure(oneChunkReadable(), true, true);
    expect(events).toEqual([
      'dst:write',
      'dst:end',
      'src:reset:relay-rst:dst-write',
      'dst:reset:relay-rst:dst-write',
    ]);
  });

  test('keeps the opposite direction open when half-close succeeds', async () => {
    expect(await runFailure(errorReadable(), false, false)).toEqual(['dst:end']);
  });
});
