import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthorizedDir } from './dest-local';

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-dest-local-'));
  sandboxes.push(dir);
  return realpathSync(dir);
}

describe('resolveAuthorizedDir', () => {
  test('created directory mode is 0755 regardless of umask', () => {
    const base = sandbox();
    const prev = process.umask(0o077);
    try {
      const result = resolveAuthorizedDir(base, ['newdir'], true);
      expect(result).toEqual({ ok: true, data: join(base, 'newdir') });
      expect(statSync(join(base, 'newdir')).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prev);
    }
  });

  test('overlong segment maps to invalid not permission_denied', () => {
    const base = sandbox();
    const result = resolveAuthorizedDir(base, ['x'.repeat(300)], true);
    expect(result).toEqual({ ok: false, code: 'invalid' });
  });

  test('symlink intermediate component is outside_roots', () => {
    const base = sandbox();
    const outside = mkdtempSync(join(tmpdir(), 'vibeterm-dest-local-out-'));
    sandboxes.push(outside);
    symlinkSync(outside, join(base, 'link'));
    const result = resolveAuthorizedDir(base, ['link', 'child'], true);
    expect(result).toEqual({ ok: false, code: 'outside_roots' });
    expect(existsSync(join(outside, 'child'))).toBe(false);
  });

  test('file in the way is not_a_directory', () => {
    const base = sandbox();
    writeFileSync(join(base, 'a-file'), 'nope');
    expect(resolveAuthorizedDir(base, ['a-file'], true)).toEqual({
      ok: false,
      code: 'not_a_directory',
    });
  });

  test('post-create realpath outside base removes the stray directory', () => {
    const actual = sandbox();
    const parent = sandbox();
    const linkBase = join(parent, 'link');
    symlinkSync(actual, linkBase);
    const result = resolveAuthorizedDir(linkBase, ['stray'], true);
    expect(result).toEqual({ ok: false, code: 'outside_roots' });
    expect(existsSync(join(actual, 'stray'))).toBe(false);
  });

  test('existing directory is returned without creating', () => {
    const base = sandbox();
    mkdirSync(join(base, 'keep'));
    expect(resolveAuthorizedDir(base, ['keep'], false)).toEqual({
      ok: true,
      data: join(base, 'keep'),
    });
  });
});
