// 接收侧的授权边界、冲突策略、会话预算与生命周期。全部直接打 receiver，不经链路。

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_FS_ROOT_ID } from '@vibeterm/shared';
import { getDb } from '../db/client';
import { createDevice } from '../db/devices';
import { createFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { devices, fileRoots } from '../db/schema';
import { createGrant, resetTransferGrantsForTests } from './grants';
import {
  type TransferSession,
  closeSession,
  forgetTransferSessionsForTests,
  getSession,
  openSession,
  resetTransferSessionsForTests,
} from './receiver';
import { commitFile, fileStatus, makeDirectory, writeFileRange } from './receiver-files';
import { sweepTransferOrphans } from './sweep';

const NODE_A = 'a'.repeat(32);
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-rx-test-'));
  dirs.push(dir);
  return dir;
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

let rootDir = '';
let rootId = '';
let deviceId = '';

function open(onConflict: 'skip' | 'overwrite' = 'skip', destPath = rootDir): TransferSession {
  const grant = createGrant({
    fromNodeId: NODE_A,
    destRootId: rootId,
    destPath,
    uid: 'u1',
  });
  const opened = openSession({
    grantId: grant.id,
    token: grant.token,
    peerNodeId: NODE_A,
    onConflict,
  });
  if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
  const session = getSession(opened.sessionId, NODE_A);
  if (!session) throw new Error('session missing');
  return session;
}

async function putWhole(session: TransferSession, rel: string, bytes: Uint8Array) {
  return writeFileRange(
    session,
    { relPath: rel, size: bytes.byteLength, offset: 0, length: bytes.byteLength },
    bodyOf(bytes)
  );
}

describe('receiver authorization and budgets', () => {
  beforeAll(() => runMigrations());

  beforeEach(async () => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    await resetTransferSessionsForTests();
    rootDir = tempDir();
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
    rootId = createFileRoot({ deviceId, path: rootDir }).id;
  });

  afterEach(async () => {
    await resetTransferSessionsForTests();
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a symlinked component inside the granted directory is refused', async () => {
    const outside = tempDir();
    symlinkSync(outside, join(rootDir, 'link'));
    const session = open();
    const written = await putWhole(session, 'link/pwned.txt', new TextEncoder().encode('x'));
    expect(written).toMatchObject({ ok: false, code: 'outside_roots' });
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
  });

  test('the boundary is the granted directory, not the root', async () => {
    mkdirSync(join(rootDir, 'inbox'), { recursive: true });
    mkdirSync(join(rootDir, 'private'), { recursive: true });
    symlinkSync(join(rootDir, 'private'), join(rootDir, 'inbox/out'));
    const session = open('overwrite', join(rootDir, 'inbox'));
    const written = await putWhole(session, 'out/leak.txt', new TextEncoder().encode('x'));
    expect(written).toMatchObject({ ok: false, code: 'outside_roots' });
    expect(existsSync(join(rootDir, 'private/leak.txt'))).toBe(false);
  });

  test('skip keeps the existing file, overwrite replaces it', async () => {
    writeFileSync(join(rootDir, 'dup.txt'), 'keep');
    const skipping = open('skip');
    expect(await fileStatus(skipping, 'dup.txt', 4)).toMatchObject({
      ok: false,
      code: 'dest_exists',
    });
    await closeSession(skipping.id);

    const overwriting = open('overwrite');
    const bytes = new TextEncoder().encode('nEwX');
    expect((await putWhole(overwriting, 'dup.txt', bytes)).ok).toBe(true);
    expect(await commitFile(overwriting, 'dup.txt', 4)).toMatchObject({ ok: true, skipped: false });
    expect(readFileSync(join(rootDir, 'dup.txt'), 'utf8')).toBe('nEwX');
  });

  test('a second registration with a different size is a conflict, not a reused record', async () => {
    const session = open('overwrite');
    expect((await putWhole(session, 'r.txt', new TextEncoder().encode('aaaa'))).ok).toBe(true);
    expect(await fileStatus(session, 'r.txt', 8)).toMatchObject({
      ok: false,
      code: 'dest_conflict',
    });
    expect(await commitFile(session, 'r.txt', 8)).toMatchObject({
      ok: false,
      code: 'dest_conflict',
    });
  });

  test('the aggregate byte budget rejects further registrations', async () => {
    const session = open('overwrite');
    session.maxBytes = 4;
    expect((await putWhole(session, 'a.txt', new TextEncoder().encode('aaaa'))).ok).toBe(true);
    expect(await fileStatus(session, 'b.txt', 4)).toMatchObject({
      ok: false,
      code: 'limit_exceeded',
    });
  });

  test('closing rejects new operations and clears partials', async () => {
    const session = open('overwrite');
    await writeFileRange(
      session,
      { relPath: 'half.bin', size: 8, offset: 0, length: 4 },
      bodyOf(new Uint8Array([1, 2, 3, 4]))
    );
    await closeSession(session.id);
    expect(getSession(session.id, NODE_A)).toBeNull();
    expect(await fileStatus(session, 'half.bin', 8)).toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    expect(existsSync(join(rootDir, 'half.bin'))).toBe(false);
    expect(readdirSync(rootDir).filter((n) => /\.part-[0-9a-f]{16}$/.test(n))).toEqual([]);
  });

  test('a partial survives a crash and a fresh grant resumes it', async () => {
    const first = open('overwrite');
    await writeFileRange(
      first,
      { relPath: 'resume.bin', size: 8, offset: 0, length: 4 },
      bodyOf(new Uint8Array([1, 2, 3, 4]))
    );
    // 崩溃：内存里的会话没了，盘上的 `.part` 还在
    forgetTransferSessionsForTests();
    resetTransferGrantsForTests();

    const second = open('overwrite');
    const state = await fileStatus(second, 'resume.bin', 8);
    expect(state).toMatchObject({ ok: true, receivedBytes: 4 });
    await writeFileRange(
      second,
      { relPath: 'resume.bin', size: 8, offset: 4, length: 4 },
      bodyOf(new Uint8Array([5, 6, 7, 8]))
    );
    expect(await commitFile(second, 'resume.bin', 8)).toMatchObject({ ok: true });
    expect([...readFileSync(join(rootDir, 'resume.bin'))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('the orphan sweep removes expired partials and keeps claimed ones', async () => {
    const orphan = join(rootDir, `old.bin.part-${'a'.repeat(16)}`);
    writeFileSync(orphan, 'stale');
    const session = open('overwrite');
    await writeFileRange(
      session,
      { relPath: 'live.bin', size: 8, offset: 0, length: 4 },
      bodyOf(new Uint8Array([1, 2, 3, 4]))
    );
    // 用「未来的现在」跨过 TTL，避免测试里改 mtime
    const swept = await sweepTransferOrphans(Date.now() + 25 * 60 * 60 * 1000);
    expect(swept.parts).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    // 正在被会话占用的半成品不能被扫掉
    expect(readdirSync(rootDir).filter((n) => /\.part-[0-9a-f]{16}$/.test(n))).toHaveLength(1);
  });

  test('directory entries are created through the authorized resolver', async () => {
    const session = open('overwrite');
    expect(await makeDirectory(session, 'tree/empty')).toEqual({ ok: true });
    expect(existsSync(join(rootDir, 'tree/empty'))).toBe(true);
    expect(await makeDirectory(session, '../escape')).toMatchObject({ ok: false, code: 'invalid' });
  });
});

// 虚拟根：零启用文件根时 `fs-root` 折算成本机设备的 `/`，授权边界仍然是 grant 绑定的那个目录。
describe('receiver on the virtual fs root', () => {
  let destDir = '';

  beforeAll(() => runMigrations());

  beforeEach(async () => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    resetTransferGrantsForTests();
    await resetTransferSessionsForTests();
    destDir = tempDir();
    const now = new Date().toISOString();
    createDevice({
      id: `dev-${Math.random().toString(16).slice(2)}`,
      name: 'local',
      type: 'local',
      authMode: 'agent',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await resetTransferSessionsForTests();
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function openVirtual(destPath = destDir): TransferSession {
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: VIRTUAL_FS_ROOT_ID,
      destPath,
      uid: 'u1',
    });
    const opened = openSession({
      grantId: grant.id,
      token: grant.token,
      peerNodeId: NODE_A,
      onConflict: 'overwrite',
    });
    if (!opened.ok) throw new Error(`open failed: ${opened.code}`);
    const session = getSession(opened.sessionId, NODE_A);
    if (!session) throw new Error('session missing');
    return session;
  }

  test('授权到 / 之下的任意目录，文件正常落盘', async () => {
    const session = openVirtual();
    const bytes = new TextEncoder().encode('virt');
    expect((await putWhole(session, 'sub/v.txt', bytes)).ok).toBe(true);
    expect(await commitFile(session, 'sub/v.txt', bytes.byteLength)).toMatchObject({ ok: true });
    expect(readFileSync(join(destDir, 'sub/v.txt'), 'utf8')).toBe('virt');
  });

  test('边界仍是授权目录：其中的符号链接写不出去', async () => {
    const outside = tempDir();
    symlinkSync(outside, join(destDir, 'link'));
    const session = openVirtual();
    const written = await putWhole(session, 'link/pwned.txt', new TextEncoder().encode('x'));
    expect(written).toMatchObject({ ok: false, code: 'outside_roots' });
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
  });

  test('一旦配置了启用的文件根，虚拟根授权不再能开会话', () => {
    const deviceId = getDb().select().from(devices).all()[0]?.id ?? '';
    createFileRoot({ deviceId, path: destDir });
    const grant = createGrant({
      fromNodeId: NODE_A,
      destRootId: VIRTUAL_FS_ROOT_ID,
      destPath: destDir,
      uid: 'u1',
    });
    expect(
      openSession({
        grantId: grant.id,
        token: grant.token,
        peerNodeId: NODE_A,
        onConflict: 'skip',
      })
    ).toMatchObject({ ok: false, code: 'root_not_found' });
  });
});
