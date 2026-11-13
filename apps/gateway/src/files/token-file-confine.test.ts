import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIRTUAL_HOME_ROOT_ID } from '@vibeterm/shared';
import { prepareArchive, resetArchiveTickets } from '../api/file-archive';
import { deleteUnderRoot } from '../api/file-delete';
import { mkdirUnderRoot } from '../api/file-mkdir';
import { moveUnderRoot, renameUnderRoot } from '../api/file-move';
import { runWithFileAccessPrincipal } from '../auth/token-scope';
import { getDb } from '../db/client';
import { createDevice } from '../db/devices';
import { createFileRoot } from '../db/file-roots';
import { runMigrations } from '../db/migrate';
import { devices, fileRoots } from '../db/schema';
import {
  installDataDirsFromDatabaseUrl,
  listDirectory,
  pushFileToDevice,
  statFile,
  tokenDenyEnv,
} from './device-storage';
import { resolveFileRoot } from './file-root';
import { tokenMutationDenied } from './token-deny-set';

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-tokconfine-')));
  dirs.push(dir);
  return dir;
}

function seedLocalDevice(): string {
  const now = new Date().toISOString();
  const id = `dev-${Math.random().toString(16).slice(2)}`;
  createDevice({
    id,
    name: 'local',
    type: 'local',
    authMode: 'agent',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('token file confinement', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];

  beforeAll(() => runMigrations());

  beforeEach(() => {
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
  });

  afterEach(() => {
    resetArchiveTickets();
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    getDb().delete(fileRoots).run();
    getDb().delete(devices).run();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('token + home-root is refused; configured root is allowed; session home-root unchanged', async () => {
    const deviceId = seedLocalDevice();
    const rootPath = tempDir();
    writeFileSync(join(rootPath, 'ok.txt'), 'ok');
    const created = createFileRoot({ deviceId, path: rootPath });

    await runWithFileAccessPrincipal('token', async () => {
      expect(await listDirectory(VIRTUAL_HOME_ROOT_ID, null)).toEqual({
        ok: false,
        code: 'root_not_found',
      });
      const tokenCfg = await listDirectory(created.id, rootPath);
      expect(tokenCfg.ok).toBe(true);
      if (tokenCfg.ok) expect(tokenCfg.data.entries.map((e) => e.name)).toContain('ok.txt');
    });

    expect(resolveFileRoot(VIRTUAL_HOME_ROOT_ID).ok).toBe(true);
  });

  test('token + $HOME root cannot stat app.env and cannot write .bashrc; session can', async () => {
    const home = tempDir();
    const install = join(home, '.local', 'share', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    const appEnv = join(install, 'app.env');
    writeFileSync(appEnv, 'VIBETERM_MASTER_KEY=test');
    writeFileSync(join(install, 'data', 'vibeterm.db'), '');
    writeFileSync(join(home, 'ok.txt'), 'ok');
    const src = join(home, 'payload.txt');
    writeFileSync(src, 'evil');

    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(
      spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(join(install, 'data', 'vibeterm.db'))
    );

    const deviceId = seedLocalDevice();
    const created = createFileRoot({ deviceId, path: home });

    await runWithFileAccessPrincipal('token', async () => {
      expect(await statFile(created.id, appEnv)).toEqual({ ok: false, code: 'permission_denied' });
      expect(await pushFileToDevice(created.id, home, src, '.bashrc')).toEqual({
        ok: false,
        code: 'permission_denied',
      });
    });

    const sessionStat = await statFile(created.id, appEnv);
    expect(sessionStat.ok).toBe(true);

    const sessionWrite = await pushFileToDevice(created.id, home, src, '.bashrc');
    expect(sessionWrite).toEqual({ ok: true, data: { uploaded: '.bashrc' } });
  });

  test('token delete/move/mkdir refuse the deny set and its ancestors; session unchanged', async () => {
    const home = tempDir();
    const install = join(home, '.local', 'share', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    writeFileSync(join(install, 'app.env'), 'VIBETERM_MASTER_KEY=test');
    mkdirSync(join(home, '.config', 'vibeterm'), { recursive: true });
    mkdirSync(join(home, 'work'), { recursive: true });
    writeFileSync(join(home, 'work', 'a.txt'), 'a');
    writeFileSync(join(home, '.bashrc'), '');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(
      spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(join(install, 'data', 'vibeterm.db'))
    );
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: home });

    await runWithFileAccessPrincipal('token', async () => {
      const del = await deleteUnderRoot(root.id, [
        join(home, '.config'),
        join(home, '.local'),
        join(home, '.bashrc'),
      ]);
      expect(del.ok).toBe(true);
      if (del.ok) {
        expect(del.data.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
          'permission_denied',
          'permission_denied',
          'permission_denied',
        ]);
      }
      const moved = await moveUnderRoot({
        rootId: root.id,
        paths: [join(home, '.config')],
        destDir: join(home, 'work'),
        onConflict: 'fail',
      } as Parameters<typeof moveUnderRoot>[0]);
      expect(moved.ok && moved.data.results[0]?.ok).toBe(false);
      const intoDenied = await moveUnderRoot({
        rootId: root.id,
        paths: [join(home, 'work', 'a.txt')],
        destDir: join(home, '.config', 'vibeterm'),
        onConflict: 'fail',
      } as Parameters<typeof moveUnderRoot>[0]);
      expect(intoDenied.ok).toBe(true);
      if (intoDenied.ok) {
        expect(intoDenied.data.results[0]).toMatchObject({
          ok: false,
          code: 'permission_denied',
        });
      }
      expect(await mkdirUnderRoot(root.id, join(home, '.ssh'), false)).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect(await mkdirUnderRoot(root.id, join(home, '.config'), false)).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect((await mkdirUnderRoot(root.id, join(home, 'work', 'new'), false)).ok).toBe(true);
    });

    const sessionDel = await deleteUnderRoot(root.id, [join(home, 'work', 'a.txt')]);
    expect(sessionDel.ok && sessionDel.data.results[0]?.ok).toBe(true);
  });

  test('token rename/move of deny names is refused; session is unaffected', async () => {
    const home = tempDir();
    const install = join(home, '.local', 'share', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
    writeFileSync(join(home, 'notes.txt'), 'n');
    mkdirSync(join(home, 'tmp', '.ssh'), { recursive: true });
    writeFileSync(join(home, 'tmp', '.ssh', 'authorized_keys'), 'ak');
    writeFileSync(join(home, 'tmp', '.bashrc'), 'evil');
    writeFileSync(join(home, '.bashrc'), 'orig');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(
      spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(join(install, 'data', 'vibeterm.db'))
    );
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: home });

    await runWithFileAccessPrincipal('token', async () => {
      expect(
        await renameUnderRoot({ rootId: root.id, path: join(home, '.ssh'), name: 'k' })
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(
        await renameUnderRoot({
          rootId: root.id,
          path: join(home, 'notes.txt'),
          name: '.bash_profile',
        })
      ).toEqual({ ok: false, code: 'permission_denied' });
      const bashrcMove = await moveUnderRoot({
        rootId: root.id,
        paths: [join(home, 'tmp', '.bashrc')],
        destDir: home,
        onConflict: 'overwrite',
      } as Parameters<typeof moveUnderRoot>[0]);
      expect(bashrcMove.ok).toBe(true);
      if (bashrcMove.ok) {
        expect(bashrcMove.data.results[0]).toMatchObject({
          ok: false,
          code: 'permission_denied',
        });
      }
      const sshMove = await moveUnderRoot({
        rootId: root.id,
        paths: [join(home, 'tmp', '.ssh')],
        destDir: home,
        onConflict: 'fail',
      } as Parameters<typeof moveUnderRoot>[0]);
      expect(sshMove.ok).toBe(true);
      if (sshMove.ok) {
        expect(sshMove.data.results[0]).toMatchObject({ ok: false, code: 'permission_denied' });
      }
    });

    const sessionRename = await renameUnderRoot({
      rootId: root.id,
      path: join(home, 'notes.txt'),
      name: 'ok.txt',
    });
    expect(sessionRename).toEqual({ ok: true, data: { path: join(home, 'ok.txt') } });
  });

  test('token cannot archive a deny entry or its ancestor; session can', async () => {
    const home = tempDir();
    const install = join(home, '.local', 'share', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    mkdirSync(join(home, '.config', 'vibeterm'), { recursive: true });
    writeFileSync(join(home, '.config', 'vibeterm', 'tokens.json'), '{}');
    writeFileSync(join(home, 'ok.txt'), 'ok');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(
      spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(join(install, 'data', 'vibeterm.db'))
    );
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: home });

    await runWithFileAccessPrincipal('token', async () => {
      expect(await prepareArchive({ rootId: root.id, paths: [home] }, 'tok')).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect(
        await prepareArchive({ rootId: root.id, paths: [join(home, '.config')] }, 'tok')
      ).toEqual({ ok: false, code: 'permission_denied' });
      const allowed = await prepareArchive(
        { rootId: root.id, paths: [join(home, 'ok.txt')] },
        'tok'
      );
      expect(allowed.ok).toBe(true);
    });

    const session = await prepareArchive({ rootId: root.id, paths: [home] }, 'sess');
    expect(session.ok).toBe(true);
  });

  test('a token covering the filesystem root covers every deny entry', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.ssh'), { recursive: true });
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const device = { id: 'local-dev', type: 'local' } as Parameters<typeof tokenMutationDenied>[0];
    await runWithFileAccessPrincipal('token', async () => {
      expect(tokenMutationDenied(device, '/', null)).toBe(true);
      expect(tokenMutationDenied(device, null, '/')).toBe(true);
    });
    expect(tokenMutationDenied(device, '/', null)).toBe(false);
  });

  test('a not-yet-created deny entry under a symlinked ancestor is refused at its real location', async () => {
    const home = tempDir();
    const realConfig = tempDir();
    symlinkSync(realConfig, join(home, '.config'));
    mkdirSync(join(realConfig, 'prepared', 'user'), { recursive: true });
    writeFileSync(join(realConfig, 'prepared', 'user', 'x.service'), '');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: realConfig });
    await runWithFileAccessPrincipal('token', async () => {
      expect(
        await renameUnderRoot({
          rootId: root.id,
          path: join(realConfig, 'prepared'),
          name: 'systemd',
        })
      ).toEqual({ ok: false, code: 'permission_denied' });
    });
  });

  test('a deny entry behind a dangling symlink is refused at the link target', async () => {
    const home = tempDir();
    const mount = tempDir();
    symlinkSync(join(mount, 'not-mounted', 'config'), join(home, '.config'));
    mkdirSync(join(mount, 'prepared', 'config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(mount, 'prepared', 'config', 'systemd', 'user', 'x.service'), '');
    mkdirSync(join(mount, 'staging', 'not-mounted', 'config', 'systemd', 'user'), {
      recursive: true,
    });
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: mount });
    await runWithFileAccessPrincipal('token', async () => {
      expect(
        await renameUnderRoot({
          rootId: root.id,
          path: join(mount, 'prepared'),
          name: 'not-mounted',
        })
      ).toEqual({ ok: false, code: 'permission_denied' });
      const moved = await moveUnderRoot({
        rootId: root.id,
        paths: [join(mount, 'staging', 'not-mounted')],
        destDir: mount,
        onConflict: 'fail',
      } as Parameters<typeof moveUnderRoot>[0]);
      expect(moved.ok && moved.data.results[0]?.ok).toBe(false);
    });
    const session = await renameUnderRoot({
      rootId: root.id,
      path: join(mount, 'prepared'),
      name: 'renamed',
    });
    expect(session.ok).toBe(true);
  });

  test('a dangling link that re-enters an existing link through .. is followed', async () => {
    const home = tempDir();
    const mount = tempDir();
    symlinkSync(`${mount}/not-mounted/../alias/config`, join(home, '.config'));
    symlinkSync(join(mount, 'not-mounted'), join(mount, 'alias'));
    mkdirSync(join(mount, 'prepared', 'config', 'systemd', 'user'), { recursive: true });
    mkdirSync(join(mount, 'plain'), { recursive: true });
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: mount });
    await runWithFileAccessPrincipal('token', async () => {
      expect(
        await renameUnderRoot({
          rootId: root.id,
          path: join(mount, 'prepared'),
          name: 'not-mounted',
        })
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(
        (await renameUnderRoot({ rootId: root.id, path: join(mount, 'plain'), name: 'other' })).ok
      ).toBe(true);
    });
  });

  test('a missing component cancelled by .. is still protected as a resolution dependency', async () => {
    const home = tempDir();
    const mount = tempDir();
    symlinkSync(`${mount}/not-mounted/../safe/config`, join(home, '.config'));
    mkdirSync(join(mount, 'pivot', 'leaf'), { recursive: true });
    symlinkSync(join(mount, 'pivot', 'leaf'), join(mount, 'prepared-link'));
    mkdirSync(join(mount, 'pivot', 'safe', 'config', 'systemd', 'user'), { recursive: true });
    mkdirSync(join(mount, 'plain'), { recursive: true });
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const deviceId = seedLocalDevice();
    const root = createFileRoot({ deviceId, path: mount });
    await runWithFileAccessPrincipal('token', async () => {
      expect(
        await renameUnderRoot({
          rootId: root.id,
          path: join(mount, 'prepared-link'),
          name: 'not-mounted',
        })
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(await mkdirUnderRoot(root.id, join(mount, 'not-mounted'), false)).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect(
        (await renameUnderRoot({ rootId: root.id, path: join(mount, 'plain'), name: 'other' })).ok
      ).toBe(true);
      expect((await mkdirUnderRoot(root.id, join(mount, 'fresh'), false)).ok).toBe(true);
      expect(await mkdirUnderRoot(root.id, join(mount, 'not-mounted', 'child'), true)).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect((await mkdirUnderRoot(root.id, join(mount, 'fresh', 'a', 'b'), true)).ok).toBe(true);
    });
  });

  test('a symlink loop is refused for tokens', async () => {
    const home = tempDir();
    const mount = tempDir();
    symlinkSync(join(mount, 'b'), join(mount, 'a'));
    symlinkSync(join(mount, 'a'), join(mount, 'b'));
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    const device = { id: 'local-dev', type: 'local' } as Parameters<typeof tokenMutationDenied>[0];
    await runWithFileAccessPrincipal('token', async () => {
      expect(tokenMutationDenied(device, null, join(mount, 'a', 'x'))).toBe(true);
      expect(tokenMutationDenied(device, null, join(mount, 'plain', 'x'))).toBe(false);
    });
  });

  test('installDataDirsFromDatabaseUrl derives data dir and install dir', () => {
    expect(installDataDirsFromDatabaseUrl(':memory:')).toEqual([]);
    expect(installDataDirsFromDatabaseUrl('file::memory:?cache=shared')).toEqual([]);
    expect(installDataDirsFromDatabaseUrl('/opt/vibeterm/data/vibeterm.db')).toEqual([
      '/opt/vibeterm/data',
      '/opt/vibeterm',
    ]);
  });
});
