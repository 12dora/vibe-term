import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listLocalDirectory,
  localFileHandle,
  localFsIo,
  mapFsError,
  pushLocalFile,
  readLocalTextFile,
  statLocalPath,
} from './local-fs';

const dirs: string[] = [];
const originalCopyFile = localFsIo.copyFile;

afterEach(() => {
  localFsIo.copyFile = originalCopyFile;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vibeterm-local-fs-'));
  dirs.push(dir);
  return dir;
}

describe('mapFsError', () => {
  test('maps common errno codes', () => {
    expect(mapFsError({ code: 'ENOENT' })).toEqual({ ok: false, code: 'not_found' });
    expect(mapFsError({ code: 'ENOTDIR' })).toEqual({ ok: false, code: 'not_a_directory' });
    expect(mapFsError({ code: 'EISDIR' })).toEqual({ ok: false, code: 'is_directory' });
    expect(mapFsError({ code: 'EACCES' })).toEqual({ ok: false, code: 'permission_denied' });
    expect(mapFsError({ code: 'EPERM' })).toEqual({ ok: false, code: 'permission_denied' });
    expect(mapFsError({ code: 'ETIMEDOUT' })).toEqual({ ok: false, code: 'timeout' });
    expect(mapFsError({ code: 'ENAMETOOLONG' })).toEqual({ ok: false, code: 'invalid' });
    expect(mapFsError({ code: 'EIO' })).toEqual({ ok: false, code: 'unknown' });
  });
});

describe('listLocalDirectory / statLocalPath', () => {
  test('lists files and directories without following entry symlinks', () => {
    const root = sandbox();
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'a.txt'), 'hello');
    symlinkSync(join(root, 'a.txt'), join(root, 'link'));

    const listed = listLocalDirectory(root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.path).toBe(root);
    expect(listed.data.truncated).toBe(false);
    expect(listed.data.entries.map((e) => e.name)).toEqual(['dir', 'a.txt', 'link']);
    const link = listed.data.entries.find((e) => e.name === 'link');
    expect(link).toMatchObject({ type: 'symlink', isSymlink: true });
    const file = listed.data.entries.find((e) => e.name === 'a.txt');
    expect(file).toMatchObject({ type: 'file', size: 5 });
  });

  test('rejects a file path as not_a_directory', () => {
    const root = sandbox();
    const file = join(root, 'f.txt');
    writeFileSync(file, 'x');
    expect(listLocalDirectory(file)).toEqual({ ok: false, code: 'not_a_directory' });
  });

  test('stat reports symlink vs file vs dir', () => {
    const root = sandbox();
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'f.txt'), 'ab');
    symlinkSync(join(root, 'f.txt'), join(root, 'l'));
    expect(statLocalPath(join(root, 'd'))).toMatchObject({
      ok: true,
      data: { type: 'dir', isSymlink: false, size: 0 },
    });
    expect(statLocalPath(join(root, 'f.txt'))).toMatchObject({
      ok: true,
      data: { type: 'file', size: 2, isSymlink: false },
    });
    expect(statLocalPath(join(root, 'l'))).toMatchObject({
      ok: true,
      data: { type: 'symlink', isSymlink: true },
    });
    expect(statLocalPath(join(root, 'missing'))).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('readLocalTextFile / localFileHandle', () => {
  test('reads utf-8 text and rejects binary / directories', () => {
    const root = sandbox();
    writeFileSync(join(root, 'ok.txt'), 'hi');
    writeFileSync(join(root, 'bin'), Buffer.from([0, 1, 2]));
    const text = readLocalTextFile(join(root, 'ok.txt'));
    expect(text.ok).toBe(true);
    if (text.ok) expect(text.data.content).toBe('hi');
    expect(readLocalTextFile(join(root, 'bin'))).toEqual({ ok: false, code: 'binary' });
    expect(readLocalTextFile(root)).toEqual({ ok: false, code: 'is_directory' });
  });

  test('localFileHandle hands out the original path and respects maxBytes', () => {
    const root = sandbox();
    const file = join(root, 'a.bin');
    writeFileSync(file, 'hello');
    const okHandle = localFileHandle(file, 100);
    expect(okHandle.ok).toBe(true);
    if (!okHandle.ok) return;
    expect(okHandle.data.tmpPath).toBe(file);
    expect(okHandle.data.size).toBe(5);
    okHandle.data.cleanup();
    expect(existsSync(file)).toBe(true);
    expect(localFileHandle(file, 4)).toMatchObject({ ok: false, code: 'too_large', detail: '4' });
    expect(localFileHandle(root, 100)).toEqual({ ok: false, code: 'is_directory' });
  });
});

describe('pushLocalFile', () => {
  test('copies onto destDir and overwrites a regular file', () => {
    const root = sandbox();
    const src = join(root, 'src.txt');
    writeFileSync(src, 'payload');
    const destDir = join(root, 'inbox');
    mkdirSync(destDir);
    writeFileSync(join(destDir, 'out.txt'), 'old');
    const progress: Array<{ pct: number }> = [];
    const res = pushLocalFile(destDir, src, 'out.txt', {
      onProgress: (p) => progress.push(p),
    });
    expect(res).toEqual({ ok: true, data: { uploaded: 'out.txt' } });
    expect(readFileSync(join(destDir, 'out.txt'), 'utf8')).toBe('payload');
    expect(progress[0]?.pct).toBe(100);
  });

  test('unlinks a dest symlink instead of writing through it', () => {
    const root = sandbox();
    const outside = sandbox();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'keep');
    const destDir = join(root, 'inbox');
    mkdirSync(destDir);
    symlinkSync(secret, join(destDir, 'out.txt'));
    const src = join(root, 'src.txt');
    writeFileSync(src, 'new');
    expect(pushLocalFile(destDir, src, 'out.txt')).toEqual({
      ok: true,
      data: { uploaded: 'out.txt' },
    });
    expect(readFileSync(join(destDir, 'out.txt'), 'utf8')).toBe('new');
    expect(readFileSync(secret, 'utf8')).toBe('keep');
  });

  test('rejects a non-directory destDir and aborted signal', () => {
    const root = sandbox();
    const file = join(root, 'not-dir');
    writeFileSync(file, 'x');
    const src = join(root, 'src.txt');
    writeFileSync(src, 'y');
    expect(pushLocalFile(file, src, 'out.txt')).toEqual({ ok: false, code: 'not_a_directory' });
    const destDir = join(root, 'inbox');
    mkdirSync(destDir);
    const controller = new AbortController();
    controller.abort();
    expect(pushLocalFile(destDir, src, 'out.txt', { signal: controller.signal })).toEqual({
      ok: false,
      code: 'unknown',
    });
  });

  test('accepts destDir that is a symlink to a directory inside the root', () => {
    const root = sandbox();
    const release = join(root, 'releases', 'x');
    mkdirSync(release, { recursive: true });
    const current = join(root, 'current');
    symlinkSync(release, current);
    const src = join(root, 'src.txt');
    writeFileSync(src, 'payload');
    expect(pushLocalFile(current, src, 'out.txt')).toEqual({
      ok: true,
      data: { uploaded: 'out.txt' },
    });
    expect(readFileSync(join(release, 'out.txt'), 'utf8')).toBe('payload');
    expect(readFileSync(join(current, 'out.txt'), 'utf8')).toBe('payload');
  });

  test('leaves dest intact when copy into the temp file fails', () => {
    const root = sandbox();
    const destDir = join(root, 'inbox');
    mkdirSync(destDir);
    const dest = join(destDir, 'out.txt');
    writeFileSync(dest, 'old');
    const src = join(root, 'src.txt');
    writeFileSync(src, 'new');
    localFsIo.copyFile = () => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    };
    expect(pushLocalFile(destDir, src, 'out.txt')).toMatchObject({ ok: false, code: 'unknown' });
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(readdirSync(destDir).filter((n) => n.includes('vibeterm-put'))).toEqual([]);
  });
});
