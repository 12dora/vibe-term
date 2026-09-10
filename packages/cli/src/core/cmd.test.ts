import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFetch, testContext } from '../commands/cli-test-harness';
import { readSecretField } from './cmd';
import { UsageError } from './errors';

describe('readSecretField', () => {
  test('prefers --flag-file over argv and does not warn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-cmd-secret-'));
    try {
      const file = join(dir, 's');
      await writeFile(file, 'file-secret\n');
      const { ctx, stderr } = await testContext(routeFetch({}), { json: true });
      const value = await readSecretField(
        ctx,
        { 'password-file': file, password: 'argv' },
        {
          flag: 'password',
          envName: 'VIBETERM_DEVICE_PASSWORD',
        }
      );
      expect(value).toBe('file-secret');
      expect(stderr.text()).not.toContain('visible to other processes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('argv warns and @file reads the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-cmd-at-'));
    try {
      const file = join(dir, 's');
      await writeFile(file, 'at-file');
      const { ctx, stderr } = await testContext(routeFetch({}), { json: true });
      const warned = await readSecretField(
        ctx,
        { password: 'argv-secret' },
        {
          flag: 'password',
          envName: 'VIBETERM_DEVICE_PASSWORD',
        }
      );
      expect(warned).toBe('argv-secret');
      expect(stderr.text()).toContain('VIBETERM_DEVICE_PASSWORD');
      const fromAt = await readSecretField(ctx, { password: `@${file}` }, { flag: 'password' });
      expect(fromAt).toBe('at-file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('required non-tty without a source is a usage error', async () => {
    const { ctx } = await testContext(routeFetch({}), { json: true });
    await expect(
      readSecretField(
        ctx,
        {},
        { flag: 'password', required: true, envName: 'VIBETERM_SHARE_PASSWORD' }
      )
    ).rejects.toBeInstanceOf(UsageError);
  });
});
