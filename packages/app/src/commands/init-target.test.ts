import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNotInstalled } from './init-target';

describe('assertNotInstalled', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });
  const makeDir = async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibeterm-init-'));
    return dir;
  };

  test('rejects an existing install and points to upgrade', async () => {
    await makeDir();
    await writeFile(join(dir, 'install-meta.json'), JSON.stringify({ cliVersion: '2.3.4' }));
    const error = await assertNotInstalled(dir).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('2.3.4');
    expect((error as Error).message).toContain(dir);
    expect((error as Error).message).toContain('vibeterm upgrade');
  });

  test('still rejects, without a version, when install-meta.json is unreadable', async () => {
    await makeDir();
    await writeFile(join(dir, 'install-meta.json'), '{broken');
    const error = await assertNotInstalled(dir).catch((e: Error) => e);
    expect((error as Error).message).toContain('vibeterm upgrade');
    expect((error as Error).message).not.toContain('unknown');
  });

  test('treats a directory with only app.env as installed', async () => {
    await makeDir();
    await writeFile(join(dir, 'app.env'), 'VIBETERM_MASTER_KEY=example\n');
    const error = await assertNotInstalled(dir).catch((e: Error) => e);
    expect((error as Error).message).toContain(dir);
    expect((error as Error).message).toContain('vibeterm upgrade');
    expect((error as Error).message).not.toContain('unknown');
  });

  test('passes for a missing or non-install directory', async () => {
    await makeDir();
    await writeFile(join(dir, 'notes.txt'), 'x');
    await expect(assertNotInstalled(dir)).resolves.toBeUndefined();
    await expect(assertNotInstalled(join(dir, 'missing'))).resolves.toBeUndefined();
  });
});
