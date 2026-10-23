import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Device } from '@vibeterm/shared';
import * as rsyncOp from '../files/rsync-operation';
import type { RsyncDeviceSpec } from '../files/ssh-command';
import type { DestContext } from './dest';
import {
  buildWalkCommand,
  parseWalkOutput,
  placeFileOnRemote,
  remotePushArgs,
} from './dest-remote';

const enc = (s: string) => new TextEncoder().encode(s);

function fakeCtx(): DestContext {
  return {
    root: { path: '/srv/root' },
    destDir: '/srv/root/dest',
  } as DestContext;
}

describe('parseWalkOutput', () => {
  it('绝对路径与已存在标记按标记长度切片，不丢字符', () => {
    expect(parseWalkOutput(enc('VTDIR /srv/uploads\nVTEXISTS 1\n'))).toEqual({
      dir: '/srv/uploads',
      exists: true,
    });
  });

  it('不存在标记为 0，且容忍 CRLF', () => {
    expect(parseWalkOutput(enc('VTDIR /home/u/dir\r\nVTEXISTS 0\r\n'))).toEqual({
      dir: '/home/u/dir',
      exists: false,
    });
  });

  it('缺任一标记时返回 null', () => {
    expect(parseWalkOutput(enc('VTDIR /x\n'))).toBeNull();
    expect(parseWalkOutput(enc('garbage\n'))).toBeNull();
  });
});

describe('buildWalkCommand', () => {
  it('creates missing segments with mode 0755 and rmdir on containment failure', () => {
    const cmd = buildWalkCommand(fakeCtx(), ['a', 'b'], 'file.txt');
    expect(cmd).toContain('mkdir -m 0755 -- "$s"');
    expect(cmd).not.toContain('mkdir -- "$s"');
    expect(cmd).toContain('rmdir -- "$s"');
    expect(cmd).toContain('exit 66');
  });
});

const spec: RsyncDeviceSpec = {
  targetPrefix: 'u@h:',
  rsh: 'ssh -p 22',
  env: {},
  cleanup: () => {},
};

describe('remotePushArgs', () => {
  it('skip 带 --ignore-existing，且从不使用 --inplace', () => {
    const skip = remotePushArgs(spec, '/tmp/src', '/dest/file', true);
    expect(skip).toContain('--ignore-existing');
    expect(skip).not.toContain('--inplace');
    const overwrite = remotePushArgs(spec, '/tmp/src', '/dest/file', false);
    expect(overwrite).not.toContain('--ignore-existing');
    expect(overwrite).not.toContain('--inplace');
  });
});

describe('placeFileOnRemote 分道', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  function sshCtx(): DestContext {
    const device: Device = {
      id: 'ssh-dest',
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
    return {
      root: {
        id: 'r',
        deviceId: device.id,
        path: '/srv/root',
        enabled: true,
        sortOrder: 0,
        createdAt: '',
      },
      device,
      destDir: '/srv/root/dest',
      realDestDir: '/srv/root/dest',
    };
  }

  it('建目录走 mutation，rsync 推送走 transfer', async () => {
    const kinds: string[] = [];
    spies.push(
      spyOn(rsyncOp, 'withDeviceRsync').mockImplementation((async (
        _device: unknown,
        kind: string
      ) => {
        kinds.push(kind);
        if (kind === 'mutation') {
          return rsyncOp.ok({ dir: '/srv/root/dest', name: 'file.txt', exists: false });
        }
        return rsyncOp.ok({ skipped: false });
      }) as unknown as typeof rsyncOp.withDeviceRsync)
    );
    const res = await placeFileOnRemote(sshCtx(), {
      rel: 'file.txt',
      localPath: '/tmp/src',
      onConflict: 'overwrite',
    });
    expect(res).toEqual({ ok: true, data: { skipped: false } });
    expect(kinds).toEqual(['mutation', 'transfer']);
  });

  it('skip 且目标已存在时只跑 mutation', async () => {
    const kinds: string[] = [];
    spies.push(
      spyOn(rsyncOp, 'withDeviceRsync').mockImplementation((async (
        _device: unknown,
        kind: string
      ) => {
        kinds.push(kind);
        return rsyncOp.ok({ dir: '/srv/root/dest', name: 'file.txt', exists: true });
      }) as unknown as typeof rsyncOp.withDeviceRsync)
    );
    const res = await placeFileOnRemote(sshCtx(), {
      rel: 'file.txt',
      localPath: '/tmp/src',
      onConflict: 'skip',
    });
    expect(res).toEqual({ ok: true, data: { skipped: true } });
    expect(kinds).toEqual(['mutation']);
  });
});
