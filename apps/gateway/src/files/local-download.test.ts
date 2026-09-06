import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@tmex/shared';
import * as devicesDb from '../db';
import * as fileRootsDb from '../db/file-roots';
import { pullFileFromDevice } from './device-storage';

const spies: Array<ReturnType<typeof spyOn>> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function localDevice(): Device {
  return {
    id: 'local-dl',
    name: 'local',
    type: 'local',
    authMode: 'auto',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function mockRoot(rootPath: string): void {
  spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(localDevice()));
  spies.push(
    spyOn(fileRootsDb, 'getFileRootById').mockReturnValue({
      id: 'root-local',
      deviceId: 'local-dl',
      path: rootPath,
      enabled: true,
      sortOrder: 0,
      createdAt: '',
    })
  );
}

describe('pullFileFromDevice 对本机设备的直读', () => {
  test('直接交出原文件路径，cleanup 是空操作', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmex-local-root-'));
    dirs.push(root);
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello');
    mockRoot(root);

    const res = await pullFileFromDevice('root-local', file);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 没有复制到 tmpdir：拿到的就是原路径
    expect(res.data.tmpPath).toBe(file);
    expect(res.data.size).toBe(5);
    expect(res.data.name).toBe('a.txt');
    res.data.cleanup();
    expect(existsSync(file)).toBe(true);
  });

  test('目录与不存在的路径按既有错误码返回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmex-local-root-'));
    dirs.push(root);
    mockRoot(root);

    expect(await pullFileFromDevice('root-local', root)).toMatchObject({
      ok: false,
      code: 'is_directory',
    });
    expect(await pullFileFromDevice('root-local', join(root, 'nope.txt'))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  test('root 之外的路径仍然被拒', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmex-local-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'tmex-local-out-'));
    dirs.push(root, outside);
    const file = join(outside, 'secret.txt');
    writeFileSync(file, 'x');
    mockRoot(root);

    expect(await pullFileFromDevice('root-local', file)).toMatchObject({
      ok: false,
      code: 'outside_roots',
    });
  });
});
