// 节点间文件传输的端到端：真实 LinkMux（含信用窗口/背压）+ 真实 mesh-internal 路由 +
// 真实可续传 sink。A 与 B 在同一进程内，但字节确实经过一条完整的 mux 流。

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinkSession } from '@tmex/shared/link';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { NodeSessionStore } from '../../auth';
import { getDb } from '../../db/client';
import { createDevice } from '../../db/devices';
import { createFileRoot } from '../../db/file-roots';
import { runMigrations } from '../../db/migrate';
import { devices, fileRoots } from '../../db/schema';
import { setTransferMeshBridge } from '../../transfer/bridge';
import { createLocalChannel } from '../../transfer/channel';
import { createGrant, resetTransferGrantsForTests } from '../../transfer/grants';
import { createJob, resetTransferJobsForTests } from '../../transfer/job-registry';
import { runTransferJob } from '../../transfer/job-runner';
import { createMeshChannel } from '../../transfer/mesh-channel';
import { resetTransferSessionsForTests } from '../../transfer/receiver';
import { Forwarder } from '../forwarder';
import { handleMeshInternalTmuxRequest } from '../mesh-internal-tmux-routes';
import { openHttpStream, openWsStream } from '../stream-targets';
import { acceptHttpStream } from '../stream-targets';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

const dirs: string[] = [];

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

type Peers = {
  linkA: LinkSession;
  linkB: LinkSession;
  /** 打开的 mux 流条数（并行度断言用） */
  opened: number;
  /** 命中该序号的 PUT 时把流打断一次，模拟中继复位 */
  breakAt: number | null;
};

function connectPeers(sessionStore: NodeSessionStore): Peers {
  const [linkA, linkB] = createInMemoryLinkPair();
  const peers: Peers = { linkA, linkB, opened: 0, breakAt: null };
  linkB.onStream((stream) => {
    void acceptHttpStream(stream, {
      peerNodeId: NODE_A,
      sessionStore,
      dispatchHttp: async (req) => handleMeshInternalTmuxRequest(req),
    });
  });
  return peers;
}

function forwarderFor(peers: Peers): Forwarder {
  return new Forwarder({
    nodeId: NODE_A,
    peers: {
      getLink: async () => peers.linkA,
      listReach: () => new Map(),
      onNodeEvent: () => () => {},
    },
    streams: {
      openHttpStream: (link, open, body, signal) => {
        peers.opened += 1;
        const index = peers.opened;
        if (peers.breakAt === index) {
          peers.breakAt = null;
          return openHttpStream(link, { type: 'http', ...open }, truncate(body), signal);
        }
        return openHttpStream(link, { type: 'http', ...open }, body, signal);
      },
      openWsStream: openWsStream as never,
    },
    log: () => {},
  });
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

function wireBridge(peers: Peers, transport: 'relay' | 'dc'): void {
  const forwarder = forwarderFor(peers);
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
  const job = createJob({
    jobId: `job-${Math.random().toString(16).slice(2)}`,
    uid: 'u1',
    fromNodeId: NODE_A,
    toNodeId,
    destRootId: dstRootId,
    destPath: dstDir,
    path: input.peers ? 'relay' : 'local',
    streams: input.streams,
  });
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
    runMigrations();
    sessionStore = new NodeSessionStore(getDb());
  });

  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    resetTransferSessionsForTests();
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

  afterEach(() => {
    setTransferMeshBridge(null);
    resetTransferJobsForTests();
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
    wireBridge(peers, 'relay');
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

  test('4 条并行流：确实开了多条 mux 流，落盘字节仍完全一致', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'dc');
    const bytes = payload(6 * 1024 * 1024, 11);
    writeFileSync(join(srcDir, 'big.bin'), bytes);

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'big.bin') }],
      streams: 4,
    });

    expect(job.snapshot.state).toBe('done');
    expect(readFileSync(join(dstDir, 'big.bin'))).toEqual(Buffer.from(bytes));
    // 建会话 + 至少一次 status + 每个分片一条 PUT + commit + close
    expect(peers.opened).toBeGreaterThan(4);
  });

  test('中途链路复位：按已收区间续传，不从零重来', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay');
    const bytes = payload(256 * 1024, 3);
    writeFileSync(join(srcDir, 'resume.bin'), bytes);
    // 第 3 条流是首个 PUT（1=sessions，2=status），把它的 body 截断一半
    peers.breakAt = 3;

    const job = await runJob({
      peers,
      items: [{ rootId: srcRootId, path: join(srcDir, 'resume.bin') }],
      streams: 1,
    });

    expect(job.snapshot.state).toBe('done');
    expect(readFileSync(join(dstDir, 'resume.bin'))).toEqual(Buffer.from(bytes));
  });

  test('目录递归展开：relPath 保留层级，目标侧自动建目录', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'dc');
    mkdirSync(join(srcDir, 'tree/inner'), { recursive: true });
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
      'tree/inner/two.txt',
      'tree/one.txt',
    ]);
    expect(readFileSync(join(dstDir, 'tree/one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(dstDir, 'tree/inner/two.txt'), 'utf8')).toBe('two');
  });

  test('grant 绑定的源节点对不上：目标拒绝建会话', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay');
    writeFileSync(join(srcDir, 'x.bin'), payload(64));
    const grant = createGrant({
      fromNodeId: NODE_B, // 授权给别的节点，A 拿着它不该建得起会话
      destRootId: dstRootId,
      destPath: dstDir,
      uid: 'u1',
    });
    const job = createJob({
      jobId: 'job-peer-mismatch',
      uid: 'u1',
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      destRootId: dstRootId,
      destPath: dstDir,
      path: 'relay',
      streams: 1,
    });
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

  test('取消：任务停在 cancelled，不会把文件落到目标', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay');
    writeFileSync(join(srcDir, 'c.bin'), payload(32 * 1024));
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: dstRootId,
      destPath: dstDir,
      uid: 'u1',
    });
    const job = createJob({
      jobId: 'job-cancel',
      uid: 'u1',
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      destRootId: dstRootId,
      destPath: dstDir,
      path: 'relay',
      streams: 1,
    });
    job.abort.abort();
    await runTransferJob({
      job,
      channel: createMeshChannel(NODE_B),
      grant: { grantId: grant.id, token: grant.token },
      items: [{ rootId: srcRootId, path: join(srcDir, 'c.bin') }],
      onConflict: 'skip',
      streams: 1,
    });
    expect(job.snapshot.state).toBe('cancelled');
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

  test('onConflict=skip：目标已存在同名文件时跳过', async () => {
    const peers = connectPeers(sessionStore);
    wireBridge(peers, 'relay');
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
