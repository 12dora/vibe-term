import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_FS_ROOT_ID, VIRTUAL_HOME_ROOT_ID } from '@vibeterm/shared';
import { getDb } from '../db/client';
import { createDevice } from '../db/devices';
import { createFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { devices, fileRoots } from '../db/schema';
import { listDirectory, pushFileToDevice, statFile } from './device-storage';
import { hasEnabledFileRoots, resolveFileRoot, virtualHomeRootForList } from './file-root';
import * as rsyncMod from './rsync';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-root-unit-'));
  dirs.push(dir);
  return dir;
}

function seedDevice(type: 'local' | 'ssh'): string {
  const now = new Date().toISOString();
  const id = `dev-${Math.random().toString(16).slice(2)}`;
  createDevice({
    id,
    name: type,
    type,
    host: type === 'ssh' ? '127.0.0.1' : undefined,
    username: type === 'ssh' ? 'nobody' : undefined,
    authMode: 'agent',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('resolveFileRoot', () => {
  beforeAll(() => runMigrations());

  // 共享内存库：别的用例可能留下设备 / 文件根，本用例对「零启用根」敏感，进出都清一遍
  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
  });

  afterEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('一条启用的根都没有时，虚拟根折算成本机设备的 /', () => {
    const deviceId = seedDevice('local');
    expect(hasEnabledFileRoots()).toBe(false);
    const resolved = resolveFileRoot(VIRTUAL_FS_ROOT_ID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.root).toMatchObject({
      id: VIRTUAL_FS_ROOT_ID,
      deviceId,
      path: '/',
      enabled: true,
    });
  });

  test('存在启用的根时虚拟根立即失效，与不存在的 id 同码', () => {
    const deviceId = seedDevice('local');
    createFileRoot({ deviceId, path: tempDir() });
    expect(hasEnabledFileRoots()).toBe(true);
    expect(resolveFileRoot(VIRTUAL_FS_ROOT_ID)).toEqual({ ok: false, code: 'root_not_found' });
    expect(resolveFileRoot('no-such-root')).toEqual({ ok: false, code: 'root_not_found' });
  });

  test('只有被禁用的根时虚拟根仍然可用', () => {
    const deviceId = seedDevice('local');
    const disabled = createFileRoot({ deviceId, path: tempDir(), enabled: false });
    expect(hasEnabledFileRoots()).toBe(false);
    expect(resolveFileRoot(VIRTUAL_FS_ROOT_ID).ok).toBe(true);
    expect(resolveFileRoot(disabled.id)).toEqual({ ok: false, code: 'root_disabled' });
  });

  test('没有本机设备时虚拟根解析失败', () => {
    seedDevice('ssh');
    expect(resolveFileRoot(VIRTUAL_FS_ROOT_ID)).toEqual({ ok: false, code: 'device_not_found' });
  });

  test('真实根照旧返回原行', () => {
    const deviceId = seedDevice('local');
    const path = tempDir();
    const created = createFileRoot({ deviceId, path });
    const resolved = resolveFileRoot(created.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.root).toMatchObject({ id: created.id, path, enabled: true });
  });

  test('列目录经虚拟根可以浏览文件系统任意位置', async () => {
    seedDevice('local');
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const res = await listDirectory(VIRTUAL_FS_ROOT_ID, dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.path).toBe(dir);
    expect(res.data.entries.map((entry) => entry.name)).toContain('a.txt');
  });

  test('配置了根之后，经虚拟根的列目录退回 root_not_found', async () => {
    const deviceId = seedDevice('local');
    const dir = tempDir();
    createFileRoot({ deviceId, path: dir });
    const res = await listDirectory(VIRTUAL_FS_ROOT_ID, dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('root_not_found');
  });

  test('home-root 绑定本机 $HOME，即使已有其它启用根也可解析', () => {
    const deviceId = seedDevice('local');
    createFileRoot({ deviceId, path: tempDir() });
    const resolved = resolveFileRoot(VIRTUAL_HOME_ROOT_ID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.root).toMatchObject({
      id: VIRTUAL_HOME_ROOT_ID,
      deviceId,
      path: realpathSync(homedir()),
      enabled: true,
    });
    expect(virtualHomeRootForList()?.id).toBe(VIRTUAL_HOME_ROOT_ID);
  });

  test('用户启用根展示名为 home 时，home-root 解析到用户根且列表不再附带虚拟项', () => {
    const deviceId = seedDevice('local');
    const homePath = join(tempDir(), 'home');
    mkdirSync(homePath);
    const created = createFileRoot({ deviceId, path: homePath });
    const resolved = resolveFileRoot(VIRTUAL_HOME_ROOT_ID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.root).toMatchObject({ id: created.id, path: homePath });
    expect(virtualHomeRootForList()).toBeNull();
  });

  test('禁用的 home 名根不遮蔽虚拟 home-root', () => {
    const deviceId = seedDevice('local');
    const homePath = join(tempDir(), 'home');
    mkdirSync(homePath);
    createFileRoot({ deviceId, path: homePath, enabled: false });
    const resolved = resolveFileRoot(VIRTUAL_HOME_ROOT_ID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.root.id).toBe(VIRTUAL_HOME_ROOT_ID);
  });

  test('没有本机设备时 home-root 解析失败', () => {
    seedDevice('ssh');
    expect(resolveFileRoot(VIRTUAL_HOME_ROOT_ID)).toEqual({ ok: false, code: 'device_not_found' });
    expect(virtualHomeRootForList()).toBeNull();
  });

  test('本机 list/stat/push 不 spawn rsync', async () => {
    const deviceId = seedDevice('local');
    const dir = tempDir();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const created = createFileRoot({ deviceId, path: dir });
    const spy = spyOn(rsyncMod, 'runRsync').mockImplementation(async () => {
      throw new Error('rsync must not run for local devices');
    });
    try {
      const listed = await listDirectory(created.id, dir);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.entries.map((e) => e.name)).toContain('a.txt');
      const st = await statFile(created.id, join(dir, 'a.txt'));
      expect(st.ok).toBe(true);
      const src = join(dir, 'src.txt');
      writeFileSync(src, 'payload');
      const pushed = await pushFileToDevice(created.id, dir, src, 'out.txt');
      expect(pushed).toEqual({ ok: true, data: { uploaded: 'out.txt' } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
