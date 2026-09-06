import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TransferJobEvent, VIRTUAL_FS_ROOT_ID } from '@vibeterm/shared';
import { dispatchRoutes } from '../api/route';
import { getDb } from '../db/client';
import { createDevice } from '../db/devices';
import { createFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { devices, fileRoots } from '../db/schema';
import { requestDispatchContext } from '../mesh/types';
import { setTransferMeshBridge, streamsForTransport } from './bridge';
import { joinPosix, normalizeRelPath, resolveDestContext } from './dest';
import { expandItems } from './expand';
import { consumeGrant, createGrant, resetTransferGrantsForTests } from './grants';
import { createJob, resetTransferJobsForTests } from './job-registry';
import { MAX_JOBS_PER_USER } from './limits';
import { transferRoutes } from './routes';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-tx-unit-'));
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

describe('transfer grants', () => {
  beforeEach(() => resetTransferGrantsForTests());

  test('single use: the second redemption is rejected', () => {
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: 'root-1',
      destPath: '/tmp',
      uid: 'u1',
    });
    expect(consumeGrant({ grantId: grant.id, token: grant.token, peerNodeId: NODE_A }).ok).toBe(
      true
    );
    expect(consumeGrant({ grantId: grant.id, token: grant.token, peerNodeId: NODE_A })).toEqual({
      ok: false,
      code: 'grant_invalid',
    });
  });

  test('a different peer cannot redeem someone else grant', () => {
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: 'root-1',
      destPath: '/tmp',
      uid: 'u1',
    });
    expect(consumeGrant({ grantId: grant.id, token: grant.token, peerNodeId: NODE_B })).toEqual({
      ok: false,
      code: 'peer_mismatch',
    });
  });

  test('a wrong token is rejected and an expired grant reports expiry', () => {
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: 'root-1',
      destPath: '/tmp',
      uid: 'u1',
    });
    expect(consumeGrant({ grantId: grant.id, token: 'nope', peerNodeId: NODE_A })).toEqual({
      ok: false,
      code: 'grant_invalid',
    });
    expect(
      consumeGrant({
        grantId: grant.id,
        token: grant.token,
        peerNodeId: NODE_A,
        now: grant.expiresAt + 1,
      })
    ).toEqual({ ok: false, code: 'grant_expired' });
  });
});

describe('dest path safety', () => {
  test('relative paths cannot escape the destination directory', () => {
    expect(normalizeRelPath('a/b.txt')).toBe('a/b.txt');
    expect(normalizeRelPath('./a//b.txt')).toBe('a/b.txt');
    expect(normalizeRelPath('../etc/passwd')).toBeNull();
    expect(normalizeRelPath('a/../../b')).toBeNull();
    expect(normalizeRelPath('/abs')).toBeNull();
    expect(normalizeRelPath('a\0b')).toBeNull();
    expect(normalizeRelPath('')).toBeNull();
  });

  test('joinPosix keeps a single separator', () => {
    expect(joinPosix('/a', 'b')).toBe('/a/b');
    expect(joinPosix('/a/', 'b')).toBe('/a/b');
  });
});

describe('stream negotiation', () => {
  test('relay links get fewer parallel streams than direct ones', () => {
    expect(streamsForTransport('relay')).toBe(2);
    expect(streamsForTransport('dc')).toBe(4);
    expect(streamsForTransport(null)).toBe(4);
  });
});

describe('transfer routes', () => {
  let rootDir = '';
  let rootId = '';

  beforeAll(() => runMigrations());

  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    resetTransferJobsForTests();
    rootDir = tempDir();
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
    rootId = createFileRoot({ deviceId, path: rootDir }).id;
    setTransferMeshBridge({
      selfNodeId: NODE_A,
      transportOf: () => 'relay',
      forwardInternalHttp: async () => new Response('{}', { status: 200 }),
    });
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

  test('grants: `self` is normalized to the local node id', async () => {
    const res = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: 'self',
      destRootId: rootId,
      destPath: rootDir,
    })) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grantId: string; token: string; expiresAt: number };
    expect(body.grantId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(consumeGrant({ grantId: body.grantId, token: body.token, peerNodeId: NODE_A }).ok).toBe(
      true
    );
  });

  test('grants: a destination outside the root is rejected with a top-level code', async () => {
    const res = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: NODE_B,
      destRootId: rootId,
      destPath: '/etc',
    })) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'outside_roots' });
  });

  test('jobs: a missing grant is a 400 with code grant_invalid', async () => {
    const res = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: NODE_B,
      items: [{ rootId, path: join(rootDir, 'a.txt') }],
      destRootId: rootId,
      destPath: rootDir,
    })) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'grant_invalid' });
  });

  test('jobs: create, list, read and cancel; events start with a snapshot', async () => {
    writeFileSync(join(rootDir, 'a.txt'), 'hello');
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: rootId,
      destPath: rootDir,
      uid: 'u1',
    });
    const created = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: 'self',
      items: [{ rootId, path: join(rootDir, 'a.txt') }],
      destRootId: rootId,
      destPath: rootDir,
      grant: { grantId: grant.id, token: grant.token },
    })) as Response;
    expect(created.status).toBe(200);
    const { job } = (await created.json()) as { job: { jobId: string; toNodeId: string } };
    expect(job.toNodeId).toBe(NODE_A);

    const listed = (await dispatch('GET', '/api/transfer/jobs')) as Response;
    expect(((await listed.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);

    const events = (await dispatch('GET', `/api/transfer/jobs/${job.jobId}/events`)) as Response;
    const text = await events.text();
    const lines = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TransferJobEvent);
    expect(lines[0]?.type).toBe('snapshot');
    expect(lines.at(-1)?.type).toBe('end');

    const cancelled = (await dispatch('DELETE', `/api/transfer/jobs/${job.jobId}`)) as Response;
    expect(cancelled.status).toBe(200);
  });

  test('admission: a user cannot queue more than the per-user job budget', async () => {
    // 直接登记占位任务（没有 runner，会一直停在 queued），把预算占满
    for (let i = 0; i < MAX_JOBS_PER_USER; i += 1) {
      createJob({
        jobId: `queued-${i}`,
        uid: 'u1',
        fromNodeId: NODE_A,
        toNodeId: NODE_B,
        destRootId: rootId,
        destPath: rootDir,
        path: 'relay',
        streams: 1,
      });
    }
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: rootId,
      destPath: rootDir,
      uid: 'u1',
    });
    writeFileSync(join(rootDir, 'over.txt'), 'x');
    const res = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: 'self',
      items: [{ rootId, path: join(rootDir, 'over.txt') }],
      destRootId: rootId,
      destPath: rootDir,
      grant: { grantId: grant.id, token: grant.token },
    })) as Response;
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'too_many_jobs' });
    // 另一个用户不受这个用户的占用影响
    const other = (await dispatch(
      'POST',
      '/api/transfer/jobs',
      {
        toNodeId: 'self',
        items: [{ rootId, path: join(rootDir, 'over.txt') }],
        destRootId: rootId,
        destPath: rootDir,
        grant: { grantId: grant.id, token: grant.token },
      },
      'u2'
    )) as Response;
    expect(other.status).toBe(200);
  });

  test('jobs from another user are not visible', async () => {
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: rootId,
      destPath: rootDir,
      uid: 'u1',
    });
    writeFileSync(join(rootDir, 'b.txt'), 'x');
    const created = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: 'self',
      items: [{ rootId, path: join(rootDir, 'b.txt') }],
      destRootId: rootId,
      destPath: rootDir,
      grant: { grantId: grant.id, token: grant.token },
    })) as Response;
    const { job } = (await created.json()) as { job: { jobId: string } };
    const other = (await dispatch(
      'GET',
      `/api/transfer/jobs/${job.jobId}`,
      undefined,
      'u2'
    )) as Response;
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('source expansion', () => {
  let rootDir = '';
  let rootId = '';

  beforeAll(() => runMigrations());

  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    rootDir = tempDir();
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
    rootId = createFileRoot({ deviceId, path: rootDir }).id;
  });

  afterEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('directories expand recursively and oversized files are marked up front', async () => {
    mkdirSync(join(rootDir, 'd/e'), { recursive: true });
    writeFileSync(join(rootDir, 'd/small.txt'), 'ab');
    writeFileSync(join(rootDir, 'd/e/big.txt'), 'abcdefghij');
    const expanded = await expandItems([{ rootId, path: join(rootDir, 'd') }], {
      maxFileBytes: 4,
      signal: new AbortController().signal,
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const byRel = Object.fromEntries(expanded.entries.map((f) => [f.relPath, f]));
    expect(Object.keys(byRel).sort()).toEqual(['d', 'd/e', 'd/e/big.txt', 'd/small.txt']);
    expect(byRel['d/small.txt']?.error).toBeUndefined();
    expect(byRel['d/e/big.txt']?.error).toBe('quota_file_size');
    expect(byRel.d?.type).toBe('dir');
  });

  test('empty directories are part of the manifest', async () => {
    mkdirSync(join(rootDir, 'tree/empty'), { recursive: true });
    const expanded = await expandItems([{ rootId, path: join(rootDir, 'tree') }], {
      maxFileBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.entries.map((e) => e.relPath).sort()).toEqual(['tree', 'tree/empty']);
    expect(expanded.entries.every((e) => e.type === 'dir')).toBe(true);
  });

  test('two sources landing on the same relative path are flagged as a conflict', async () => {
    mkdirSync(join(rootDir, 'one'), { recursive: true });
    mkdirSync(join(rootDir, 'two'), { recursive: true });
    writeFileSync(join(rootDir, 'one/report.txt'), 'aaaa');
    writeFileSync(join(rootDir, 'two/report.txt'), 'bbbb');
    const expanded = await expandItems(
      [
        { rootId, path: join(rootDir, 'one/report.txt') },
        { rootId, path: join(rootDir, 'two/report.txt') },
      ],
      { maxFileBytes: 1024, signal: new AbortController().signal }
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.entries).toHaveLength(2);
    expect(expanded.entries[0].error).toBeUndefined();
    expect(expanded.entries[1].error).toBe('dest_conflict');
  });

  test('a directory larger than the visited-entry cap fails instead of transferring a subset', async () => {
    const many = join(rootDir, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 40; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x');
    const expanded = await expandItems([{ rootId, path: many }], {
      maxFileBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    // 40 个文件 + 目录自身，一条不少
    expect(expanded.entries).toHaveLength(41);
  });

  test('a resolvable destination context normalizes the directory', () => {
    const resolved = resolveDestContext(rootId, `${rootDir}/./`);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.data.destDir).toBe(rootDir);
  });
});

// 零启用文件根时，前端合成的 `fs-root` 必须一路通到 grant 与任务创建。
describe('transfer routes on the virtual fs root', () => {
  let destDir = '';
  let deviceId = '';

  beforeAll(() => runMigrations());

  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    resetTransferJobsForTests();
    destDir = tempDir();
    const now = new Date().toISOString();
    deviceId = `dev-${Math.random().toString(16).slice(2)}`;
    createDevice({
      id: deviceId,
      name: 'local',
      type: 'local',
      authMode: 'agent',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    setTransferMeshBridge({
      selfNodeId: NODE_A,
      transportOf: () => 'relay',
      forwardInternalHttp: async () => new Response('{}', { status: 200 }),
    });
  });

  afterEach(() => {
    setTransferMeshBridge(null);
    resetTransferJobsForTests();
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('grant 与任务都接受 fs-root', async () => {
    writeFileSync(join(destDir, 'v.txt'), 'hello');
    const granted = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: NODE_A,
      destRootId: VIRTUAL_FS_ROOT_ID,
      destPath: destDir,
    })) as Response;
    expect(granted.status).toBe(200);
    const grant = (await granted.json()) as { grantId: string; token: string };

    const created = (await dispatch('POST', '/api/transfer/jobs', {
      toNodeId: 'self',
      items: [{ rootId: VIRTUAL_FS_ROOT_ID, path: join(destDir, 'v.txt') }],
      destRootId: VIRTUAL_FS_ROOT_ID,
      destPath: destDir,
      grant,
    })) as Response;
    expect(created.status).toBe(200);
    const { job } = (await created.json()) as { job: { destRootId: string } };
    expect(job.destRootId).toBe(VIRTUAL_FS_ROOT_ID);
  });

  test('源侧展开经 fs-root 可以枚举授权目录之外的路径', async () => {
    const other = tempDir();
    writeFileSync(join(other, 'x.txt'), 'x');
    const expanded = await expandItems(
      [{ rootId: VIRTUAL_FS_ROOT_ID, path: join(other, 'x.txt') }],
      {
        maxFileBytes: 1024,
        signal: new AbortController().signal,
      }
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.entries.map((entry) => entry.relPath)).toEqual(['x.txt']);
  });

  test('配置了启用的文件根之后 fs-root 立即被拒', async () => {
    createFileRoot({ deviceId, path: destDir });
    const granted = (await dispatch('POST', '/api/transfer/grants', {
      fromNodeId: NODE_A,
      destRootId: VIRTUAL_FS_ROOT_ID,
      destPath: destDir,
    })) as Response;
    expect(granted.status).toBe(400);
    expect(await granted.json()).toMatchObject({ code: 'root_not_found' });
  });
});
