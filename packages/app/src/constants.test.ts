import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVICE_NAME,
  defaultDatabasePath,
  defaultInstallDir,
  legacyInstallDir,
  newInstallDir,
  pickInstallDir,
} from './constants';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('install directory defaults', () => {
  test('service name and database file use the new brand', () => {
    expect(DEFAULT_SERVICE_NAME).toBe('vibeterm');
    expect(defaultDatabasePath('/opt/x')).toBe('/opt/x/data/vibeterm.db');
  });

  test('new and legacy defaults are the platform directories', () => {
    expect(newInstallDir('darwin')).toBe(
      join(homedir(), 'Library', 'Application Support', 'vibeterm')
    );
    expect(legacyInstallDir('darwin')).toBe(
      join(homedir(), 'Library', 'Application Support', 'tmex')
    );
    expect(newInstallDir('linux')).toBe(join(homedir(), '.local', 'share', 'vibeterm'));
    expect(legacyInstallDir('linux')).toBe(join(homedir(), '.local', 'share', 'tmex'));
  });

  test('falls back to the legacy directory only when it holds an install', () => {
    const has = (dirs: string[]) => (dir: string) => dirs.includes(dir);
    expect(pickInstallDir('/new', '/old', has([]))).toBe('/new');
    expect(pickInstallDir('/new', '/old', has(['/old']))).toBe('/old');
    expect(pickInstallDir('/new', '/old', has(['/new']))).toBe('/new');
    expect(pickInstallDir('/new', '/old', has(['/new', '/old']))).toBe('/new');
  });

  test('defaultInstallDir picks one of the two platform paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-home-'));
    tempDirs.push(dir);
    expect([newInstallDir('linux'), legacyInstallDir('linux')]).toContain(
      defaultInstallDir('linux')
    );
  });
});
