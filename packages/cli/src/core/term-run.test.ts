import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors';
import { isPaneShell, resolveRunBody } from './term-run';

describe('isPaneShell', () => {
  test('treats login shells and empty command as idle', () => {
    expect(isPaneShell('zsh')).toBe(true);
    expect(isPaneShell('-bash')).toBe(true);
    expect(isPaneShell('/bin/sh')).toBe(true);
    expect(isPaneShell('tmux')).toBe(true);
    expect(isPaneShell('')).toBe(true);
    expect(isPaneShell(undefined)).toBe(true);
  });

  test('treats other foreground processes as busy', () => {
    expect(isPaneShell('vim')).toBe(false);
    expect(isPaneShell('apt')).toBe(false);
    expect(isPaneShell('needrestart')).toBe(false);
    expect(isPaneShell('ssh')).toBe(false);
    expect(isPaneShell('sudo')).toBe(false);
    expect(isPaneShell('su')).toBe(false);
    expect(isPaneShell('doas')).toBe(false);
    expect(isPaneShell('docker')).toBe(false);
    expect(isPaneShell('kubectl')).toBe(false);
  });
});

describe('resolveRunBody', () => {
  test('reads @file as a paste body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-run-body-'));
    try {
      const file = join(dir, 's.sh');
      await writeFile(file, 'echo a\necho b\n');
      const body = await resolveRunBody({}, [`@${file}`]);
      expect(body.paste).toBe(true);
      expect(body.commandLine).toBe('echo a\necho b');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('normalizes CRLF and CR in @file to LF and strips a trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-run-crlf-'));
    try {
      const file = join(dir, 's.sh');
      await writeFile(file, 'echo a\r\necho b\recho c\r\n');
      const body = await resolveRunBody({}, [`@${file}`]);
      expect(body.paste).toBe(true);
      expect(body.commandLine).toBe('echo a\necho b\necho c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a multi-line argv command', async () => {
    await expect(resolveRunBody({}, ['echo a\necho b'])).rejects.toBeInstanceOf(UsageError);
  });
});
