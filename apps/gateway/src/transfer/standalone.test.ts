import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferJobEvent, TransferJobSnapshot } from '@vibeterm/shared';
import { dispatchRoutes } from '../api/route';
import { getDb } from '../db/client';
import { createDevice } from '../db/devices';
import { createFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { devices, fileRoots } from '../db/schema';
import { requestDispatchContext } from '../mesh/types';
import { STANDALONE_TRANSFER_NODE_ID, setTransferMeshBridge, transferSelfNodeId } from './bridge';
import { consumeGrant, createGrant, resetTransferGrantsForTests } from './grants';
import { getJob, listJobs, resetTransferJobsForTests } from './job-registry';
import { closeSession, openSession } from './receiver';
import { transferRoutes } from './routes';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-tx-standalone-'));
  dirs.push(dir);
  return dir;
}

function dispatch(method: string, path: string, body?: unknown, uid = 'u1') {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  requestDispatchContext.set(req, { uid, viaNodeId: 'self' });
  const pathname = new URL(req.url).pathname;
  return dispatchRoutes(req, pathname, transferRoutes, { path: pathname });
}

async function waitForTerminal(jobId: string): Promise<TransferJobSnapshot> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (job && job.snapshot.finishedAt !== null) return job.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe('transfer without a mesh bridge', () => {
  let srcDir = '';
  let dstDir = '';
  let srcRootId = '';
  let dstRootId = '';

  beforeAll(() => runMigrations());

  beforeEach(() => {
    setTransferMeshBridge(null);
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    resetTransferJobsForTests();
    srcDir = tempDir();
    dstDir = tempDir();
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
    resetTransferGrantsForTests();
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function issueGrant(): Promise<{ grantId: string; token: string }> {
    const res = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: 'self',
      destRootId: dstRootId,
      destPath: dstDir,
    })) as Response;
    expect(res.status).toBe(200);
    return (await res.json()) as { grantId: string; token: string };
  }

  async function startJob(
    sources: string[],
    onConflict?: 'skip' | 'overwrite'
  ): Promise<TransferJobSnapshot> {
    const grant = await issueGrant();
    const created = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: 'self',
      items: sources.map((path) => ({ rootId: srcRootId, path })),
      destRootId: dstRootId,
      destPath: dstDir,
      grant,
      ...(onConflict ? { onConflict } : {}),
    })) as Response;
    expect(created.status).toBe(200);
    const { job } = (await created.json()) as { job: TransferJobSnapshot };
    return await waitForTerminal(job.jobId);
  }

  test('self id falls back to the standalone constant', () => {
    expect(STANDALONE_TRANSFER_NODE_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(transferSelfNodeId()).toBe(STANDALONE_TRANSFER_NODE_ID);
  });

  test('a file and a directory tree are copied between two roots', async () => {
    writeFileSync(join(srcDir, 'a.txt'), 'hello');
    mkdirSync(join(srcDir, 'tree/sub/empty'), { recursive: true });
    writeFileSync(join(srcDir, 'tree/one.txt'), 'one');
    writeFileSync(join(srcDir, 'tree/sub/two.txt'), 'two');

    const finished = await startJob([join(srcDir, 'a.txt'), join(srcDir, 'tree')]);
    expect(finished.state).toBe('done');
    expect(finished.path).toBe('local');
    expect(finished.fromNodeId).toBe(STANDALONE_TRANSFER_NODE_ID);
    expect(finished.toNodeId).toBe(STANDALONE_TRANSFER_NODE_ID);
    expect(readFileSync(join(dstDir, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dstDir, 'tree/one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(dstDir, 'tree/sub/two.txt'), 'utf8')).toBe('two');
    expect(existsSync(join(dstDir, 'tree/sub/empty'))).toBe(true);
    // 源文件不动
    expect(readFileSync(join(srcDir, 'a.txt'), 'utf8')).toBe('hello');

    const eventsPath = `/api/transfer/jobs/${finished.jobId}/events`;
    const events = (await dispatch('GET', eventsPath)) as Response;
    const lines = (await events.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TransferJobEvent);
    expect(lines[0]?.type).toBe('snapshot');
    expect(lines.at(-1)?.type).toBe('end');
    const jobPath = `/api/transfer/jobs/${finished.jobId}`;
    const cancelled = (await dispatch('DELETE', jobPath)) as Response;
    expect(cancelled.status).toBe(200);
  });

  test("onConflict 'skip' keeps the existing target, 'overwrite' replaces it", async () => {
    writeFileSync(join(srcDir, 'c.txt'), 'new content');
    writeFileSync(join(dstDir, 'c.txt'), 'old');

    const skipped = await startJob([join(srcDir, 'c.txt')], 'skip');
    expect(skipped.state).toBe('done');
    expect(skipped.items.find((item) => item.relPath === 'c.txt')?.state).toBe('skipped');
    expect(readFileSync(join(dstDir, 'c.txt'), 'utf8')).toBe('old');

    const overwritten = await startJob([join(srcDir, 'c.txt')], 'overwrite');
    expect(overwritten.state).toBe('done');
    expect(readFileSync(join(dstDir, 'c.txt'), 'utf8')).toBe('new content');
  });

  test('a job to a foreign node answers 503 unavailable and registers nothing', async () => {
    writeFileSync(join(srcDir, 'f.txt'), 'x');
    const grant = await issueGrant();
    const res = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: NODE_B,
      items: [{ rootId: srcRootId, path: join(srcDir, 'f.txt') }],
      destRootId: dstRootId,
      destPath: dstDir,
      grant,
    })) as Response;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'unavailable' });
    expect(listJobs('u1')).toHaveLength(0);
    expect(existsSync(join(dstDir, 'f.txt'))).toBe(false);
  });

  test('a grant issued for `self` cannot be consumed by another node', async () => {
    const grant = await issueGrant();
    const foreign = openSession({
      grantId: grant.grantId,
      token: grant.token,
      peerNodeId: NODE_B,
    });
    expect(foreign).toMatchObject({ ok: false, code: 'peer_mismatch' });
    // 被拒的尝试不烧掉授权；本机身份仍能核销
    const own = openSession({
      grantId: grant.grantId,
      token: grant.token,
      peerNodeId: transferSelfNodeId(),
    });
    expect(own.ok).toBe(true);
    if (own.ok) await closeSession(own.sessionId);
  });
});

describe('transfer with a mesh bridge', () => {
  beforeEach(() => {
    resetTransferGrantsForTests();
    setTransferMeshBridge({
      selfNodeId: NODE_A,
      transportOf: () => 'dc',
      forwardInternalHttp: async () => new Response('{}', { status: 200 }),
    });
  });

  afterEach(() => {
    setTransferMeshBridge(null);
    resetTransferGrantsForTests();
  });

  test('the self id is the bridge id and `self` grants bind to it', async () => {
    expect(transferSelfNodeId()).toBe(NODE_A);
    const rootId = 'root-1';
    const res = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: 'self',
      destRootId: rootId,
      destPath: '/tmp',
    })) as Response;
    // 根不存在 -> 校验在 grant 创建前失败，说明走的是正常路径而不是 503
    expect(res.status).toBe(400);

    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: rootId,
      destPath: '/tmp',
      uid: 'u1',
    });
    expect(
      consumeGrant({
        grantId: grant.id,
        token: grant.token,
        peerNodeId: STANDALONE_TRANSFER_NODE_ID,
      })
    ).toEqual({ ok: false, code: 'peer_mismatch' });
    expect(consumeGrant({ grantId: grant.id, token: grant.token, peerNodeId: NODE_A }).ok).toBe(
      true
    );
  });
});
