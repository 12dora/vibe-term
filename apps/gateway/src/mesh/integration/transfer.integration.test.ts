// 节点间文件传输的端到端：真实 LinkMux（含信用窗口/背压）+ 真实 mesh-internal 路由 +
// 真实可续传 sink。A 与 B 在同一进程内，但字节确实经过一条完整的 mux 流。
// 分片大小压到 256 KiB（`VIBETERM_TRANSFER_CHUNK_BYTES`），这样几百 KiB 的样本就能跑出多分片并行。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinkSession } from '@vibeterm/shared/link';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { NodeSessionStore } from '../../auth';
import { getDb } from '../../db/client';
import { createDevice } from '../../db/devices';
import { createFileRoot } from '../../db/file-roots';
import { runMigrations } from '../../db/migrate';
import { devices, fileRoots } from '../../db/schema';
import { setTransferMeshBridge } from '../../transfer/bridge';
import { createLocalChannel } from '../../transfer/channel';
import { expandItems } from '../../transfer/expand';
import { createGrant, resetTransferGrantsForTests } from '../../transfer/grants';
import { createJob, resetTransferJobsForTests } from '../../transfer/job-registry';
import { runTransferJob } from '../../transfer/job-runner';
import { createMeshChannel } from '../../transfer/mesh-channel';
import { resetTransferSessionsForTests } from '../../transfer/receiver';
import { Forwarder } from '../forwarder';
import { handleMeshInternalTmuxRequest } from '../mesh-internal-tmux-routes';
import { acceptHttpStream, openHttpStream, openWsStream } from '../stream-targets';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const CHUNK_BYTES = 256 * 1024;

const dirs: string[] = [];
let previousChunkEnv: string | undefined;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function payload(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + seed) % 251;
  return out;
}

interface Peers {
  linkA: LinkSession;
  linkB: LinkSession;
  /** 打开的 mux 流条数（并行度断言用） */
  opened: number;
  /** PUT 流条数与同时在途的峰值 */
  puts: number;
  concurrentPuts: number;
  maxConcurrentPuts: number;
  /** 经 PUT body 实际上行的字节数 */
  putBytes: number;
  /** 命中该序号的 PUT 时把流打断一次，并换一对新链路，模拟中继复位后重连 */
  breakAtPut: number | null;
  /** PUT 上行累计超过该字节数后触发一次回调（用于「写到一半再取消」） */
  cancelAfterBytes: number | null;
  onCancelPoint: (() => void) | null;
  /** 每次 status 回来的已收字节数 */
  statusReceived: number[];
}

function attach(peers: Peers, link: LinkSession, sessionStore: NodeSessionStore): void {
  link.onStream((stream) => {
    void acceptHttpStream(stream, {
      peerNodeId: NODE_A,
      sessionStore,
      dispatchHttp: async (req) => handleMeshInternalTmuxRequest(req),
    });
  });
}

function connectPeers(sessionStore: NodeSessionStore): Peers {
  const [linkA, linkB] = createInMemoryLinkPair();
  const peers: Peers = {
    linkA,
    linkB,
    opened: 0,
    puts: 0,
    concurrentPuts: 0,
    maxConcurrentPuts: 0,
    putBytes: 0,
    breakAtPut: null,
    cancelAfterBytes: null,
    onCancelPoint: null,
    statusReceived: [],
  };
  attach(peers, linkB, sessionStore);
  return peers;
}

/** 换一对链路：旧的关掉，新的接上同一套 mesh-internal 路由——重试时会开在新链路上。 */
function reconnect(peers: Peers, sessionStore: NodeSessionStore): void {
  const [linkA, linkB] = createInMemoryLinkPair();
  const oldA = peers.linkA;
  const oldB = peers.linkB;
  peers.linkA = linkA;
  peers.linkB = linkB;
  attach(peers, linkB, sessionStore);
  oldA.close('relay-reset');
  oldB.close('relay-reset');
}

/** 只送前半段就干净地结束 body——中继 RST 在应用层看起来正是这个样子。 */
function truncate(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done || !value) {
        controller.close();
        return;
      }
      if (sent > 0) {
        void reader.cancel().catch(() => {});
        controller.close();
        return;
      }
      const half = Math.max(1, Math.floor(value.byteLength / 2));
      sent += half;
      controller.enqueue(value.subarray(0, half));
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

function countBody(
  peers: Peers,
  body: ReadableStream<Uint8Array> | null
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        peers.putBytes += chunk.byteLength;
        if (peers.cancelAfterBytes !== null && peers.putBytes >= peers.cancelAfterBytes) {
          peers.cancelAfterBytes = null;
          peers.onCancelPoint?.();
        }
        controller.enqueue(chunk);
      },
    })
  );
}

function spyStatus(peers: Peers, res: Response, isStatus: boolean): Response {
  if (!isStatus) return res;
  const clone = res.clone();
  void clone
    .json()
    .then((body) => {
      const received = (body as { receivedBytes?: number }).receivedBytes;
      if (typeof received === 'number') peers.statusReceived.push(received);
    })
    .catch(() => undefined);
  return res;
}

function forwarderFor(peers: Peers, sessionStore: NodeSessionStore): Forwarder {
  return new Forwarder({
    nodeId: NODE_A,
    peers: {
      getLink: async () => peers.linkA,
      listReach: () => new Map(),
      onNodeEvent: () => () => {},
    },
    streams: {
      openHttpStream: async (link, open, body, signal) => {
        peers.opened += 1;
        const isPut = open.method === 'PUT';
        const isStatus = open.path.endsWith('/status');
        let outgoing = body;
        if (isPut) {
          peers.puts += 1;
          peers.concurrentPuts += 1;
          peers.maxConcurrentPuts = Math.max(peers.maxConcurrentPuts, peers.concurrentPuts);
          outgoing = countBody(peers, body);
          if (peers.breakAtPut === peers.puts) {
            peers.breakAtPut = null;
            outgoing = truncate(outgoing);
            reconnect(peers, sessionStore);
          }
        }
        try {
          const res = await openHttpStream(link, { type: 'http', ...open }, outgoing, signal);
          return spyStatus(peers, res, isStatus);
        } finally {
          if (isPut) peers.concurrentPuts -= 1;
        }
      },
      openWsStream: openWsStream as never,
    },
    log: () => {},
  });
}

function wireBridge(peers: Peers, transport: 'relay' | 'dc', sessionStore: NodeSessionStore): void {
  const forwarder = forwarderFor(peers, sessionStore);
  setTransferMeshBridge({
    selfNodeId: NODE_A,
    transportOf: () => transport,
    forwardInternalHttp: (nodeId, path, body, signal, input) =>
      forwarder.forwardInternalHttp(nodeId, path, body, signal, input),
  });
}

let srcDir = '';
let dstDir = '';
let srcRootId = '';
let dstRootId = '';
let sessionStore: NodeSessionStore;

function newJob(input: { toNodeId: string; streams: number; jobId?: string }) {
  return createJob({
    jobId: input.jobId ?? `job-${Math.random().toString(16).slice(2)}`,
    uid: 'u1',
    fromNodeId: NODE_A,
    toNodeId: input.toNodeId,
    destRootId: dstRootId,
    destPath: dstDir,
    path: input.toNodeId === NODE_A ? 'local' : 'relay',
    streams: input.streams,
  });
}

async function runJob(input: {
  peers: Peers | null;
  items: Array<{ rootId: string; path: string }>;
  streams: number;
  onConflict?: 'skip' | 'overwrite';
  toNodeId?: string;
}) {
  const grant = createGrant({
    fromNodeId: NODE_A,
    destRootId: dstRootId,
    destPath: dstDir,
    uid: 'u1',
  });
  const toNodeId = input.toNodeId ?? NODE_B;
  const job = newJob({ toNodeId, streams: input.streams });
  await runTransferJob({
    job,
    channel: input.peers ? createMeshChannel(toNodeId) : createLocalChannel(NODE_A),
    grant: { grantId: grant.id, token: grant.token },
    items: input.items,
    onConflict: input.onConflict ?? 'skip',
    streams: input.streams,
  });
  return job;
}

describe('node-to-node transfer over a real peer link', () => {
  beforeAll(() => {
    previousChunkEnv = process.env.VIBETERM_TRANSFER_CHUNK_BYTES;
    process.env.VIBETERM_TRANSFER_CHUNK_BYTES = String(CHUNK_BYTES);
    runMigrations();
    sessionStore = new NodeSessionStore(getDb());
  });

  afterAll(() => {
    if (previousChunkEnv === undefined) delete process.env.VIBETERM_TRANSFER_CHUNK_BYTES;
    else process.env.VIBETERM_TRANSFER_CHUNK_BYTES = previousChunkEnv;
  });

  beforeEach(async () => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    await resetTransferSessionsForTests();
    resetTransferJobsForTests();
    srcDir = tempDir('tmex-tx-src-');
    dstDir = tempDir('tmex-tx-dst-');
    const now = new Date().toISOString();
    const deviceId = `dev-${Math.random().toString(16).slice(2)}`;
    createDevice({
      id: deviceId,
      name: 'local',
      type: 'local',
      authMode: 'agent',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    srcRootId = createFileRoot({ deviceId, path: srcDir }).id;
    dstRootId = createFileRoot({ deviceId, path: dstDir }).id;
  });

  afterEach(async () => {
    setTransferMeshBridge(null);
    resetTransferJobsForTests();
    await resetTransferSessionsForTests();
    // 共享内存库：file_roots 外键指向 devices，留着会让别的用例清设备时被外键挡住
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A→B 单文件经中继路径：字节一致，任务收尾为 done', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    const bytes = payload(64 * 1024);
    writeFileSync(join(srcDir, 'a.bin'), bytes);

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'a.bin') }],
      streams: 2,
    });

    expect(job.snapshot.state).toBe('done');
    expect(job.snapshot.items).toHaveLength(1);
    expect(job.snapshot.items[0]).toMatchObject({ relPath: 'a.bin', state: 'done' });
    expect(readFileSync(join(dstDir, 'a.bin'))).toEqual(Buffer.from(bytes));
    expect(job.snapshot.progress.transferredBytes).toBe(bytes.byteLength);
  });

  test('4 条并行流：至少 4 个分片、PUT 确实同时在途，落盘字节完全一致', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'dc', sessionStore);
    const bytes = payload(CHUNK_BYTES * 6, 11);
    writeFileSync(join(srcDir, 'big.bin'), bytes);

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'big.bin') }],
      streams: 4,
    });

    expect(job.snapshot.state).toBe('done');
    expect(readFileSync(join(dstDir, 'big.bin'))).toEqual(Buffer.from(bytes));
    expect(peers.puts).toBeGreaterThanOrEqual(6);
    expect(peers.maxConcurrentPuts).toBeGreaterThanOrEqual(4);
  });

  test('传输中链路复位并重连：按已收区间续传，不从零重来', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    const bytes = payload(CHUNK_BYTES * 2, 3);
    writeFileSync(join(srcDir, 'resume.bin'), bytes);
    // 第二个 PUT 落到一半时截断并换链路：重试要在新链路上按已收区间接着传
    peers.breakAtPut = 2;

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'resume.bin') }],
      streams: 1,
    });

    expect(job.snapshot.state).toBe('done');
    expect(readFileSync(join(dstDir, 'resume.bin'))).toEqual(Buffer.from(bytes));
    // 复位之后至少有一次 status 报了非零已收字节，说明续传是按区间接着来的
    expect(peers.statusReceived.some((n) => n > 0)).toBe(true);
    // 从零重来的话上行字节会接近两倍
    expect(peers.putBytes).toBeLessThan(bytes.byteLength * 2);
  });

  test('目录递归展开：relPath 保留层级，空目录也会在目标侧建出来', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'dc', sessionStore);
    mkdirSync(join(srcDir, 'tree/inner'), { recursive: true });
    mkdirSync(join(srcDir, 'tree/empty'), { recursive: true });
    writeFileSync(join(srcDir, 'tree/one.txt'), 'one');
    writeFileSync(join(srcDir, 'tree/inner/two.txt'), 'two');

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'tree') }],
      streams: 2,
    });

    expect(job.snapshot.state).toBe('done');
    expect(job.snapshot.expanding).toBe(false);
    expect(job.snapshot.items.map((i) => i.relPath).sort()).toEqual([
      'tree',
      'tree/empty',
      'tree/inner',
      'tree/inner/two.txt',
      'tree/one.txt',
    ]);
    expect(readFileSync(join(dstDir, 'tree/one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(dstDir, 'tree/inner/two.txt'), 'utf8')).toBe('two');
    expect(existsSync(join(dstDir, 'tree/empty'))).toBe(true);
  });

  test('目标路径撞车：第二个同名条目判 dest_conflict，不覆盖第一个', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    mkdirSync(join(srcDir, 'one'), { recursive: true });
    mkdirSync(join(srcDir, 'two'), { recursive: true });
    writeFileSync(join(srcDir, 'one/report.txt'), 'aaaa');
    writeFileSync(join(srcDir, 'two/report.txt'), 'bbbb');

    const job = await runJob({
      peers,
      items: [
        { rootId: srcRootId, path: join(srcDir, 'one/report.txt') },
        { rootId: srcRootId, path: join(srcDir, 'two/report.txt') },
      ],
      streams: 1,
      onConflict: 'overwrite',
    });

    expect(job.snapshot.state).toBe('failed');
    expect(job.snapshot.error).toBe('dest_conflict');
    expect(job.snapshot.items[1]?.error).toBe('dest_conflict');
    expect(readFileSync(join(dstDir, 'report.txt'), 'utf8')).toBe('aaaa');
  });

  test('超过浏览列表上限的目录：展开一条不少（不会静默少传）', async () => {
    const many = join(srcDir, 'many');
    mkdirSync(many, { recursive: true });
    const count = 2100;
    for (let i = 0; i < count; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x');

    const expanded = await expandItems([{ rootId: srcRootId, path: many }], {
      maxFileBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.entries.filter((e) => e.type === 'file')).toHaveLength(count);
  }, 30_000);

  test('grant 绑定的源节点对不上：目标拒绝建会话', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    writeFileSync(join(srcDir, 'x.bin'), payload(64));
    const grant = createGrant({
      fromNodeId: NODE_B, // 授权给别的节点，A 拿着它不该建得起会话
      destRootId: dstRootId,
      destPath: dstDir,
      uid: 'u1',
    });
    const job = newJob({ toNodeId: NODE_B, streams: 1, jobId: 'job-peer-mismatch' });
    await runTransferJob({
      job,
      channel: createMeshChannel(NODE_B),
      grant: { grantId: grant.id, token: grant.token },
      items: [{ rootId: srcRootId, path: join(srcDir, 'x.bin') }],
      onConflict: 'skip',
      streams: 1,
    });
    expect(job.snapshot.state).toBe('failed');
    expect(job.snapshot.error).toBe('peer_mismatch');
  });

  test('写到一半再取消：任务停在 cancelled，目标只剩半成品且随会话清掉', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    const bytes = payload(CHUNK_BYTES * 4, 17);
    writeFileSync(join(srcDir, 'c.bin'), bytes);
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: dstRootId,
      destPath: dstDir,
      uid: 'u1',
    });
    const job = newJob({ toNodeId: NODE_B, streams: 1, jobId: 'job-cancel' });
    peers.cancelAfterBytes = CHUNK_BYTES;
    peers.onCancelPoint = () => job.abort.abort();

    await runTransferJob({
      job,
      channel: createMeshChannel(NODE_B),
      grant: { grantId: grant.id, token: grant.token },
      items: [{ rootId: srcRootId, path: join(srcDir, 'c.bin') }],
      onConflict: 'skip',
      streams: 1,
    });

    expect(peers.putBytes).toBeGreaterThanOrEqual(CHUNK_BYTES);
    expect(job.snapshot.state).toBe('cancelled');
    expect(job.snapshot.error).toBe('cancelled');
    expect(existsSync(join(dstDir, 'c.bin'))).toBe(false);
  });

  test('转发失败在传输层接手之前：包装过的请求体被收掉，不留悬空的读取管道', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const forwarder = new Forwarder({
      nodeId: NODE_A,
      peers: {
        getLink: async () => {
          throw new Error('offline');
        },
        listReach: () => new Map(),
        onNodeEvent: () => () => {},
      },
      streams: { openHttpStream: openHttpStream as never, openWsStream: openWsStream as never },
      log: () => {},
    });
    const res = await forwarder.forwardInternalHttp(NODE_B, '/api/x', null, undefined, {
      method: 'PUT',
      rawBody: body,
    });
    expect(res.status).toBe(503);
    expect(cancelled).toBe(true);
  });

  test('A === B：走本机通道，同样落位', async () => {
    writeFileSync(join(srcDir, 'local.bin'), payload(4096, 5));
    const job = await runJob({
      peers: null,
      items: [{ rootId: srcRootId, path: join(srcDir, 'local.bin') }],
      streams: 1,
      toNodeId: NODE_A,
    });
    expect(job.snapshot.state).toBe('done');
    expect(readFileSync(join(dstDir, 'local.bin'))).toEqual(
      readFileSync(join(srcDir, 'local.bin'))
    );
  });

  test('onConflict=skip：目标已存在同名文件时跳过且内容不变', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay', sessionStore);
    writeFileSync(join(srcDir, 'dup.bin'), payload(128));
    writeFileSync(join(dstDir, 'dup.bin'), 'keep me');

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'dup.bin') }],
      streams: 1,
    });
    expect(job.snapshot.items[0]?.state).toBe('skipped');
    expect(readFileSync(join(dstDir, 'dup.bin'), 'utf8')).toBe('keep me');
  });
});
