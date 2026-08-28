import { describe, expect, test } from 'bun:test';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeMissingEnvFileKeys,
  mergeMissingKeys,
  parseEnvContent,
  readEnvFile,
  stringifyEnv,
  writeEnvFile,
} from './env-file';
import { hubEnvDefaults } from './install';

describe('env-file', () => {
  test('parses env content', () => {
    const parsed = parseEnvContent('A=1\nB=hello\n# comment\n');
    expect(parsed).toEqual({ A: '1', B: 'hello' });
  });

  test('stringifies env with stable order', () => {
    const text = stringifyEnv({ B: '2', A: '1' });
    expect(text).toBe('A=1\nB=2\n');
  });

  test('mergeMissingKeys only adds absent keys', () => {
    const { next, added } = mergeMissingKeys(
      { TMEX_ROLES: 'node', GATEWAY_PORT: '9883' },
      hubEnvDefaults()
    );
    expect(next.TMEX_ROLES).toBe('node');
    expect(next.TMEX_HUB_URL).toBe('');
    expect(next.TMEX_PEER_PORT).toBe('39001');
    expect(next.TMEX_STUN_SERVERS).toContain('stun:stun.l.google.com:19302');
    expect(added).toContain('TMEX_HUB_URL');
    expect(added).not.toContain('TMEX_ROLES');
  });

  test('writeEnvFile replaces via temp file then rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-atomic-'));
    try {
      const path = join(dir, 'app.env');
      await writeEnvFile(path, { A: '1' });
      await writeEnvFile(path, { A: '2', B: '3' });
      const env = await readEnvFile(path);
      expect(env).toEqual({ A: '2', B: '3' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeEnvFile updates a symlinked env file without replacing the symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-symlink-'));
    try {
      const volumeDir = join(dir, 'volume');
      const overlayDir = join(dir, 'overlay');
      await mkdir(volumeDir);
      await mkdir(overlayDir);
      const realPath = join(volumeDir, 'app.env');
      const linkPath = join(overlayDir, 'app.env');
      await writeFile(realPath, 'A=1\n', { encoding: 'utf8', mode: 0o600 });
      await symlink(realPath, linkPath);

      await writeEnvFile(linkPath, { A: '2', HUB: 'joined' });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await realpath(linkPath)).toBe(await realpath(realPath));
      expect(await readEnvFile(linkPath)).toEqual({ A: '2', HUB: 'joined' });
      expect(await readEnvFile(realPath)).toEqual({ A: '2', HUB: 'joined' });
      expect(await readFile(realPath, 'utf8')).toBe('A=2\nHUB=joined\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeEnvFile creates the target of an absolute dangling symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-dangle-abs-'));
    try {
      const volumeDir = join(dir, 'volume');
      const overlayDir = join(dir, 'overlay');
      await mkdir(volumeDir);
      await mkdir(overlayDir);
      const realPath = join(volumeDir, 'app.env');
      const linkPath = join(overlayDir, 'app.env');
      await symlink(realPath, linkPath);

      await writeEnvFile(linkPath, { A: '1', HUB: 'init' });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await realpath(linkPath)).toBe(await realpath(realPath));
      expect(await readEnvFile(linkPath)).toEqual({ A: '1', HUB: 'init' });
      expect(await readEnvFile(realPath)).toEqual({ A: '1', HUB: 'init' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeEnvFile creates the target of a relative dangling symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-dangle-rel-'));
    try {
      const volumeDir = join(dir, 'volume');
      const overlayDir = join(dir, 'overlay');
      await mkdir(volumeDir);
      await mkdir(overlayDir);
      const realPath = join(volumeDir, 'app.env');
      const linkPath = join(overlayDir, 'app.env');
      await symlink('../volume/app.env', linkPath);

      await writeEnvFile(linkPath, { A: '2' });

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await realpath(linkPath)).toBe(await realpath(realPath));
      expect(await readEnvFile(linkPath)).toEqual({ A: '2' });
      expect(await readEnvFile(realPath)).toEqual({ A: '2' });
      expect(await readFile(realPath, 'utf8')).toBe('A=2\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeEnvFile throws when a symlink chain cannot be resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-dangle-cycle-'));
    try {
      const leftPath = join(dir, 'left.env');
      const rightPath = join(dir, 'right.env');
      await symlink(rightPath, leftPath);
      await symlink(leftPath, rightPath);

      await expect(writeEnvFile(leftPath, { A: '1' })).rejects.toThrow(
        /cannot resolve env file symlink/i
      );
      expect((await lstat(leftPath)).isSymbolicLink()).toBe(true);
      expect((await lstat(rightPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('upgrade merge writes only missing app.env keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-'));
    try {
      const path = join(dir, 'app.env');
      await writeEnvFile(path, { TMEX_MASTER_KEY: 'k', GATEWAY_PORT: '9883' });
      const added = await mergeMissingEnvFileKeys(path, hubEnvDefaults());
      expect(added.sort()).toEqual(
        [
          'TMEX_HUB_PUBLIC_URL',
          'TMEX_HUB_URL',
          'TMEX_PEER_PORT',
          'TMEX_ROLES',
          'TMEX_STUN_SERVERS',
        ].sort()
      );
      const env = await readEnvFile(path);
      expect(env.TMEX_MASTER_KEY).toBe('k');
      expect(env.GATEWAY_PORT).toBe('9883');
      expect(env.TMEX_ROLES).toBe('standalone');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
