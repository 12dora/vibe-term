import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireUpgradeLock,
  isLockStale,
  isPidAlive,
  processStartIdentity,
  releaseUpgradeLock,
} from './upgrade-lock';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('isPidAlive', () => {
  test('current process is alive and a huge pid is dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });
});

describe('acquireUpgradeLock', () => {
  test('creates a lock file with pid and startedAt', async () => {
    const dir = await installDir();
    const held = await acquireUpgradeLock(dir);
    try {
      const raw = await readFile(join(dir, 'upgrade.lock'), 'utf8');
      const parsed = JSON.parse(raw) as { pid: number; startedAt: string };
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.startedAt).toMatch(/^\d{4}-/);
    } finally {
      await releaseUpgradeLock(held);
    }
  });

  test('fails fast when another live pid holds the lock', async () => {
    const dir = await installDir();
    const first = await acquireUpgradeLock(dir);
    try {
      await expect(acquireUpgradeLock(dir)).rejects.toThrow(/upgrade is already running/i);
    } finally {
      await releaseUpgradeLock(first);
    }
  });

  test('reclaims a lock whose pid is dead', async () => {
    const dir = await installDir();
    await writeFile(
      join(dir, 'upgrade.lock'),
      `${JSON.stringify({ pid: 2_147_483_647, startedAt: '2026-01-01T00:00:00.000Z' })}\n`
    );
    const held = await acquireUpgradeLock(dir);
    try {
      const raw = await readFile(join(dir, 'upgrade.lock'), 'utf8');
      expect(JSON.parse(raw).pid).toBe(process.pid);
    } finally {
      await releaseUpgradeLock(held);
    }
  });

  test('reclaims a lock whose pid is alive but identity does not match', async () => {
    const dir = await installDir();
    const identity = processStartIdentity(process.pid);
    expect(identity).toBeTruthy();
    await writeFile(
      join(dir, 'upgrade.lock'),
      `${JSON.stringify({
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        identity: 'some-other-process-start-identity',
      })}\n`
    );
    expect(
      isLockStale({
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        identity: 'some-other-process-start-identity',
      })
    ).toBe(true);
    const held = await acquireUpgradeLock(dir);
    try {
      const raw = await readFile(join(dir, 'upgrade.lock'), 'utf8');
      expect(JSON.parse(raw).pid).toBe(process.pid);
      expect(JSON.parse(raw).identity).toBe(identity);
    } finally {
      await releaseUpgradeLock(held);
    }
  });

  test('creates the install directory when missing', async () => {
    const parent = await installDir();
    const dir = join(parent, 'missing');
    const held = await acquireUpgradeLock(dir);
    try {
      expect(await readFile(join(dir, 'upgrade.lock'), 'utf8')).toContain(String(process.pid));
    } finally {
      await releaseUpgradeLock(held);
    }
  });
});
