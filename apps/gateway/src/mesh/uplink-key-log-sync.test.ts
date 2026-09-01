import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@tmex/shared/auth';
import { ImmediateScheduler, waitUntil } from './test-support';
import type { KeyLogApplier, KeyLogForkEvent } from './types';
import { UplinkKeyLogSync, type UplinkKeyLogSyncHost } from './uplink-key-log-sync';
import type { UplinkKeyLogAck, UplinkNodeList } from './uplink-protocol';
import { decodeUplinkCtl } from './uplink-protocol';

function nodeList(
  over: Partial<UplinkNodeList> & { key_log_head: UplinkNodeList['key_log_head'] }
): UplinkNodeList {
  return {
    t: 'node.list',
    version: 1,
    rtc: { stun: [], turn: null },
    nodes: [],
    ...over,
  };
}

function dummyApplier(head: { seq: bigint; hash: Uint8Array }): KeyLogApplier {
  return {
    async head() {
      return head;
    },
    async applyMany() {
      return { applied: 0 };
    },
  };
}

function makeHost(over: Partial<UplinkKeyLogSyncHost> = {}) {
  let generation = 1;
  let authenticated = true;
  let online = true;
  const sent: Uint8Array[] = [];
  const torn: string[] = [];
  const persisted: UplinkNodeList[] = [];
  const emitted: UplinkNodeList[] = [];
  const host: UplinkKeyLogSyncHost = {
    generation: () => generation,
    isAuthenticated: () => authenticated,
    userId: () => 'user-1',
    isOnline: () => online,
    send: (bytes) => {
      sent.push(bytes);
    },
    tearDown: (reason) => {
      torn.push(reason);
    },
    persistList: (list) => {
      persisted.push(list);
    },
    emitNodeList: (list) => {
      emitted.push(list);
    },
    ...over,
  };
  return {
    host,
    sent,
    torn,
    persisted,
    emitted,
    bump: () => {
      generation += 1;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
    setAuthenticated: (value: boolean) => {
      authenticated = value;
    },
  };
}

describe('UplinkKeyLogSync', () => {
  test('matching heads persist then emit node.list and do not tear down', async () => {
    const hash = new Uint8Array(32);
    hash[0] = 1;
    const { host, torn, persisted, emitted } = makeHost();
    const sync = new UplinkKeyLogSync({
      host,
      applier: dummyApplier({ seq: 1n, hash }),
      scheduler: new ImmediateScheduler(),
      timeoutMs: 50,
      retryLimit: 1,
    });
    sync.reset('init');
    const list = nodeList({ key_log_head: { seq: 1n, hash } });
    sync.ingestNodeList(list);
    await waitUntil(() => emitted.length === 1);
    expect(persisted).toEqual([list]);
    expect(emitted).toEqual([list]);
    expect(torn).toEqual([]);
  });

  test('same seq different hash forks and tears down without emitting node.list', async () => {
    const local = new Uint8Array(32);
    local[0] = 1;
    const remote = new Uint8Array(32);
    remote[0] = 2;
    const forks: KeyLogForkEvent[] = [];
    const { host, torn, emitted } = makeHost();
    const sync = new UplinkKeyLogSync({
      host,
      applier: dummyApplier({ seq: 1n, hash: local }),
      scheduler: new ImmediateScheduler(),
      timeoutMs: 50,
      retryLimit: 1,
      onFork: (event) => forks.push(event),
    });
    sync.reset('init');
    sync.ingestNodeList(nodeList({ key_log_head: { seq: 1n, hash: remote } }));
    await waitUntil(() => torn.length === 1);
    expect(torn).toEqual(['key_log_fork']);
    expect(forks).toHaveLength(1);
    expect(forks[0]?.userId).toBe('user-1');
    expect(emitted).toEqual([]);
  });

  test('stale generation cannot failFork or tear down after reset', async () => {
    const hash0 = new Uint8Array(32);
    const hung = { release() {} };
    let applyCalls = 0;
    const forks: KeyLogForkEvent[] = [];
    const rec = { seq: 1n, bytes: randomBytes(8), sig: randomBytes(64) };
    const { host, torn, emitted, sent, bump } = makeHost();
    const sync = new UplinkKeyLogSync({
      host,
      applier: {
        async head() {
          return { seq: 0n, hash: hash0 };
        },
        async applyMany() {
          applyCalls += 1;
          await new Promise<void>((resolve) => {
            hung.release = resolve;
          });
          return { applied: 0, error: 'fork' };
        },
      },
      scheduler: new ImmediateScheduler(),
      timeoutMs: 200,
      retryLimit: 1,
      onFork: (event) => forks.push(event),
    });
    sync.reset('init');
    sync.ingestNodeList(nodeList({ key_log_head: { seq: 3n, hash: new Uint8Array(32).fill(3) } }));
    await waitUntil(() => sent.length === 1);
    const req = decodeUplinkCtl(sent[0] ?? new Uint8Array());
    expect(req.t).toBe('key.log.req');
    if (req.t === 'key.log.req') {
      sync.handleKeyLogRes({ t: 'key.log.res', records: [rec], id: req.id });
    }
    await waitUntil(() => applyCalls === 1);
    const previous = sync.snapshotTasks(1);
    sync.reset('reconnect');
    bump();
    sync.ingestNodeList(nodeList({ key_log_head: { seq: 0n, hash: hash0 } }));
    await waitUntil(() => emitted.length === 1);
    hung.release();
    await sync.awaitSnapshot(previous);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forks).toEqual([]);
    expect(torn).toEqual([]);
    expect(emitted).toHaveLength(1);
  });

  test('HUB_NOT_WRITER append ack is non-fatal: keeps local records and does not tear down', async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const localHash = new Uint8Array(32).fill(9);
      const rec = { seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) };
      const { host, sent, torn, emitted } = makeHost();
      const sync = new UplinkKeyLogSync({
        host,
        applier: {
          async head() {
            return { seq: 2n, hash: localHash };
          },
          async applyMany() {
            return { applied: 0 };
          },
          async list() {
            return [rec];
          },
        },
        scheduler: new ImmediateScheduler(),
        timeoutMs: 5_000,
        retryLimit: 3,
      });
      sync.reset('init');
      sync.ingestNodeList(
        nodeList({
          key_log_head: { seq: 1n, hash: new Uint8Array(32).fill(1) },
        })
      );
      await waitUntil(() => sent.length === 1);
      const append = decodeUplinkCtl(sent[0] ?? new Uint8Array());
      expect(append.t).toBe('key.log.append');
      if (append.t === 'key.log.append' && append.id) {
        sync.handleKeyLogAck({
          t: 'key.log.ack',
          id: append.id,
          ok: false,
          error: 'HUB_NOT_WRITER',
        });
      }
      await waitUntil(() => emitted.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(torn).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(
        warnings.some((row) => row.includes('HUB_NOT_WRITER') || row.includes('not writer'))
      ).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test('reset rejects pending append acks as offline', async () => {
    const { host, sent } = makeHost();
    const sync = new UplinkKeyLogSync({
      host,
      applier: dummyApplier({ seq: 0n, hash: new Uint8Array(32) }),
      scheduler: new ImmediateScheduler(),
      timeoutMs: 50,
      retryLimit: 1,
    });
    sync.reset('init');
    const pending = sync.appendAndAck({ bytes: randomBytes(8), sig: randomBytes(64) }, 5_000);
    await waitUntil(() => sent.length === 1);
    const append = decodeUplinkCtl(sent[0] ?? new Uint8Array());
    expect(append.t).toBe('key.log.append');
    sync.reset('reconnect');
    const ack: UplinkKeyLogAck = await pending;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('offline');
  });

  test('key.log.res missing id is dropped and warned once while a request is pending', async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const { host, sent } = makeHost();
      const sync = new UplinkKeyLogSync({
        host,
        applier: dummyApplier({ seq: 0n, hash: new Uint8Array(32) }),
        scheduler: new ImmediateScheduler(),
        timeoutMs: 5_000,
        retryLimit: 1,
      });
      sync.reset('init');
      const pending = sync.queryKeyLogAt(2n, 5_000);
      await waitUntil(() => sent.length === 1);
      const req = decodeUplinkCtl(sent[0] ?? new Uint8Array());
      expect(req.t).toBe('key.log.req');
      const rec = { seq: 2n, bytes: randomBytes(8), sig: randomBytes(64) };
      sync.handleKeyLogRes({ t: 'key.log.res', records: [rec] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(warnings.some((row) => row.includes('missing'))).toBe(true);
      const before = warnings.filter((row) => row.includes('missing')).length;
      sync.handleKeyLogRes({ t: 'key.log.res', records: [rec] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(warnings.filter((row) => row.includes('missing'))).toHaveLength(before);
      if (req.t === 'key.log.req') {
        sync.handleKeyLogRes({ t: 'key.log.res', records: [rec], id: req.id });
      }
      const found = await pending;
      expect(found?.bytes).toEqual(rec.bytes);
    } finally {
      console.warn = orig;
    }
  });
});
