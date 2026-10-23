import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { Device } from '@vibeterm/shared';
import { identityValidators } from '../api/file-serve';
import * as devicesDb from '../db';
import * as fileRootsDb from '../db/file-roots';
import { pullFileFromDevice, readRawFile } from './device-storage';
import * as rsyncMod from './rsync';
import * as rsyncOp from './rsync-operation';
import type { RsyncDeviceSpec } from './ssh-command';

const spies: Array<ReturnType<typeof spyOn>> = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
});

function sshDevice(): Device {
  return {
    id: 'ssh-pull',
    name: 'ssh',
    type: 'ssh',
    host: 'h',
    port: 22,
    username: 'u',
    authMode: 'key',
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function mockSshRoot(rootPath = '/data'): void {
  spies.push(spyOn(devicesDb, 'getDeviceById').mockReturnValue(sshDevice()));
  spies.push(
    spyOn(fileRootsDb, 'getFileRootById').mockReturnValue({
      id: 'root-ssh',
      deviceId: 'ssh-pull',
      path: rootPath,
      enabled: true,
      sortOrder: 0,
      createdAt: '',
    })
  );
  const spec: RsyncDeviceSpec = {
    targetPrefix: 'u@h:',
    rsh: 'ssh',
    env: {},
    cleanup: () => {},
  };
  spies.push(
    spyOn(rsyncOp, 'withDeviceRsync').mockImplementation(async (_device, _kind, fn) => fn(spec))
  );
}

function listingLine(size: number, stamp: string, name: string): string {
  return `-rw-r--r--            ${size} ${stamp} ${name}\n`;
}

function mockRsyncPulls(listing: string, payload: string): void {
  spies.push(
    spyOn(rsyncMod, 'runRsync').mockImplementation(async (argv) => {
      if (argv.includes('--list-only')) {
        return { stdout: listing, stderr: '', exitCode: 0 };
      }
      const dest = argv[argv.length - 1];
      writeFileSync(dest, payload);
      return { stdout: '', stderr: '', exitCode: 0 };
    })
  );
}

describe('SSH pull 校验器取自源文件身份', () => {
  test('两次拉取未变源得到相同 validators；源变更则不同', async () => {
    mockSshRoot();
    mockRsyncPulls(listingLine(5, '2026/06/14 15:06:34', 'a.bin'), 'hello');

    const first = await pullFileFromDevice('root-ssh', '/data/a.bin');
    const second = await pullFileFromDevice('root-ssh', '/data/a.bin');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.temporary).toBe(true);
    expect(first.data.source).toEqual(second.data.source);
    expect('path' in first.data.source).toBe(true);
    expect(identityValidators(first.data.source)).toEqual(identityValidators(second.data.source));
    first.data.cleanup();
    second.data.cleanup();

    spies.pop()?.mockRestore();
    mockRsyncPulls(listingLine(5, '2026/06/14 16:00:00', 'a.bin'), 'hello');
    const changed = await pullFileFromDevice('root-ssh', '/data/a.bin');
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(identityValidators(changed.data.source)).not.toEqual(
      identityValidators(first.data.source)
    );
    changed.data.cleanup();
  });

  test('readRawFile 同样带上源路径身份', async () => {
    mockSshRoot();
    mockRsyncPulls(listingLine(5, '2026/06/14 15:06:34', 'a.bin'), 'hello');
    const raw = await readRawFile('root-ssh', '/data/a.bin');
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    expect(raw.data.temporary).toBe(true);
    expect(raw.data.source).toMatchObject({ size: 5, path: '/data/a.bin' });
    expect(raw.data.source.mtimeMs).toBe(Date.parse('2026-06-14T15:06:34'));
    raw.data.cleanup();
  });
});
