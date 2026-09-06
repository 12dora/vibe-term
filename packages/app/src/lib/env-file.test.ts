import { afterEach, describe, expect, test } from 'bun:test';
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
  resolveEnvWriteTarget,
  stringifyEnv,
  writeEnvFile,
} from './env-file';
import { hubEnvDefaults } from './install';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
      { VIBETERM_ROLES: 'node', GATEWAY_PORT: '9883' },
      hubEnvDefaults()
    );
    expect(next.VIBETERM_ROLES).toBe('node');
    expect(next.VIBETERM_HUB_URL).toBe('');
    expect(next.VIBETERM_PEER_PORT).toBe('39001');
    expect(next.VIBETERM_STUN_SERVERS).toContain('stun:stun.l.google.com:19302');
    expect(added).toContain('VIBETERM_HUB_URL');
    expect(added).not.toContain('VIBETERM_ROLES');
  });

  test('writeEnvFile replaces via temp file then rename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-atomic-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-symlink-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-dangle-abs-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-dangle-rel-'));
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

  test('resolveEnvWriteTarget follows existing absolute and relative symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-target-'));
    try {
      const volumeDir = join(dir, 'volume');
      const overlayDir = join(dir, 'overlay');
      await mkdir(volumeDir);
      await mkdir(overlayDir);
      const realPath = join(volumeDir, 'app.env');
      await writeFile(realPath, 'A=1\n', { encoding: 'utf8', mode: 0o600 });
      const absLink = join(overlayDir, 'abs.env');
      const relLink = join(overlayDir, 'rel.env');
      await symlink(realPath, absLink);
      await symlink('../volume/app.env', relLink);

      expect(await resolveEnvWriteTarget(absLink)).toBe(await realpath(realPath));
      expect(await resolveEnvWriteTarget(relLink)).toBe(await realpath(realPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('resolveEnvWriteTarget falls back to the missing target of a dangling symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-target-dangle-'));
    try {
      const volumeDir = join(dir, 'volume');
      const overlayDir = join(dir, 'overlay');
      await mkdir(volumeDir);
      await mkdir(overlayDir);
      const realPath = join(volumeDir, 'app.env');
      const absLink = join(overlayDir, 'abs.env');
      const relLink = join(overlayDir, 'rel.env');
      await symlink(realPath, absLink);
      await symlink('../volume/app.env', relLink);

      expect(await resolveEnvWriteTarget(absLink)).toBe(realPath);
      expect(await resolveEnvWriteTarget(relLink)).toBe(realPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('resolveEnvWriteTarget returns the original path when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-target-missing-'));
    try {
      const path = join(dir, 'app.env');
      expect(await resolveEnvWriteTarget(path)).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeEnvFile throws when a symlink chain cannot be resolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-dangle-cycle-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-'));
    try {
      const path = join(dir, 'app.env');
      await writeEnvFile(path, { VIBETERM_MASTER_KEY: 'k', GATEWAY_PORT: '9883' });
      const added = await mergeMissingEnvFileKeys(path, hubEnvDefaults());
      expect(added.sort()).toEqual(
        [
          'VIBETERM_HUB_PUBLIC_URL',
          'VIBETERM_HUB_URL',
          'VIBETERM_PEER_PORT',
          'VIBETERM_ROLES',
          'VIBETERM_STUN_SERVERS',
        ].sort()
      );
      const env = await readEnvFile(path);
      expect(env.VIBETERM_MASTER_KEY).toBe('k');
      expect(env.GATEWAY_PORT).toBe('9883');
      expect(env.VIBETERM_ROLES).toBe('standalone');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeMissingKeys legacy prefix equivalence', () => {
  test('an existing TMEX_X satisfies the VIBETERM_X default', () => {
    const { next, added } = mergeMissingKeys(
      { TMEX_MASTER_KEY: 'k', TMEX_ROLES: 'node' },
      { VIBETERM_MASTER_KEY: 'generated', VIBETERM_ROLES: 'standalone', VIBETERM_PEER_PORT: '9884' }
    );
    expect(added).toEqual(['VIBETERM_PEER_PORT']);
    expect(next.TMEX_MASTER_KEY).toBe('k');
    expect(next.VIBETERM_MASTER_KEY).toBeUndefined();
    expect(next.VIBETERM_PEER_PORT).toBe('9884');
  });

  test('non-prefixed keys are still filled in', () => {
    const { next, added } = mergeMissingKeys({ TMEX_ROLES: 'node' }, { GATEWAY_PORT: '9883' });
    expect(added).toEqual(['GATEWAY_PORT']);
    expect(next.GATEWAY_PORT).toBe('9883');
  });

  test('mergeMissingEnvFileKeys does not duplicate a legacy key on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-legacy-'));
    tempDirs.push(dir);
    const file = join(dir, 'app.env');
    await writeFile(file, 'TMEX_ROLES=node\nTMEX_HUB_URL=https://hub.example\n');

    const added = await mergeMissingEnvFileKeys(file, {
      VIBETERM_ROLES: 'standalone',
      VIBETERM_HUB_URL: '',
      VIBETERM_PEER_PORT: '9884',
    });

    expect(added).toEqual(['VIBETERM_PEER_PORT']);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('TMEX_ROLES=node');
    expect(text).not.toContain('VIBETERM_ROLES=');
    expect(text).toContain('VIBETERM_PEER_PORT=9884');
  });
});

describe('legacy env key aliases', () => {
  test('readEnvFile exposes TMEX_* keys under their VIBETERM_* name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-alias-'));
    tempDirs.push(dir);
    const envPath = join(dir, 'app.env');
    await writeFile(
      envPath,
      ['TMEX_RELAY_ADMIN_TOKEN=tok', 'TMEX_ROLES=node', 'VIBETERM_ROLES=hub', ''].join('\n')
    );

    const values = await readEnvFile(envPath);
    // 迁移之前直接读 app.env 的命令（relay status 等）也要能拿到新键
    expect(values.VIBETERM_RELAY_ADMIN_TOKEN).toBe('tok');
    expect(values.TMEX_RELAY_ADMIN_TOKEN).toBe('tok');
    // 显式写过的新键优先
    expect(values.VIBETERM_ROLES).toBe('hub');
  });

  test('writing back a read env does not duplicate the aliased keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-env-alias-write-'));
    tempDirs.push(dir);
    const envPath = join(dir, 'app.env');
    await writeFile(envPath, ['TMEX_MASTER_KEY=k', 'GATEWAY_PORT=9883', ''].join('\n'));

    const values = await readEnvFile(envPath);
    await writeEnvFile(envPath, { ...values, GATEWAY_PORT: '9884' });

    const text = await readFile(envPath, 'utf8');
    expect(text).toContain('TMEX_MASTER_KEY=k');
    expect(text).not.toContain('VIBETERM_MASTER_KEY=');
    expect(text).toContain('GATEWAY_PORT=9884');
  });
});
