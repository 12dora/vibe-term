import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate';
import { t } from '../i18n';
import { cleanupMoveTest, errorBody, move, sandbox } from './file-move-test-utils';

beforeAll(() => {
  runMigrations();
});

afterEach(cleanupMoveTest);

describe('POST /api/files/move (local)', () => {
  test('moves a file and a directory into a subdirectory', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'folder', 'inner.txt'), 'inner');
    const paths = [join(dir, 'a.txt'), join(dir, 'folder')];

    const { status, json } = await move({ rootId, paths, destDir: join(dir, 'dest') });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path: paths[0], ok: true, dest: join(dir, 'dest', 'a.txt') },
        { path: paths[1], ok: true, dest: join(dir, 'dest', 'folder') },
      ],
    });
    expect(readFileSync(join(dir, 'dest', 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'dest', 'folder', 'inner.txt'), 'utf8')).toBe('inner');
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(existsSync(join(dir, 'folder'))).toBe(false);
  });

  test('normalizes . and .. in paths and echoes the normalized path', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a.txt'), 'a');

    const { json } = await move({
      rootId,
      paths: [`${dir}/dest/../a.txt`],
      destDir: `${dir}/./dest`,
    });

    expect(json).toEqual({
      results: [{ path: join(dir, 'a.txt'), ok: true, dest: join(dir, 'dest', 'a.txt') }],
    });
  });

  test('source already in destDir is an ok no-op', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'dest', 'same.txt'), 'same');
    const path = join(dir, 'dest', 'same.txt');

    const { status, json } = await move({ rootId, paths: [path], destDir: join(dir, 'dest') });

    expect(status).toBe(200);
    expect(json).toEqual({ results: [{ path, ok: true, dest: path }] });
    expect(readFileSync(path, 'utf8')).toBe('same');
  });

  test('moving a directory into itself or a descendant is invalid per item', async () => {
    const { dir, rootId } = sandbox();
    mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
    const path = join(dir, 'd');

    for (const destDir of [join(dir, 'd'), join(dir, 'd', 'sub')]) {
      const { status, json } = await move({ rootId, paths: [path], destDir });
      expect(status).toBe(200);
      expect(json).toEqual({ results: [{ path, ok: false, code: 'invalid' }] });
    }
    expect(existsSync(join(dir, 'd', 'sub'))).toBe(true);
  });

  test('root itself and out-of-root paths fail per item, the batch continues', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    const outside = join(dir, '..', 'elsewhere.txt');
    const paths = [dir, outside, join(dir, 'ghost.txt'), join(dir, 'ok.txt')];

    const { status, json } = await move({ rootId, paths, destDir: join(dir, 'dest') });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path: dir, ok: false, code: 'invalid' },
        { path: outside, ok: false, code: 'outside_roots' },
        { path: join(dir, 'ghost.txt'), ok: false, code: 'not_found' },
        { path: join(dir, 'ok.txt'), ok: true, dest: join(dir, 'dest', 'ok.txt') },
      ],
    });
    expect(existsSync(join(dir, 'dest', 'ok.txt'))).toBe(true);
  });

  test('default and explicit fail conflicts keep both files', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'f.txt'), 'new');
    writeFileSync(join(dir, 'dest', 'f.txt'), 'old');
    const path = join(dir, 'f.txt');

    for (const onConflict of [undefined, 'fail']) {
      const destDir = join(dir, 'dest');
      const { json } = await move({ rootId, paths: [path], destDir, onConflict });
      expect(json).toEqual({ results: [{ path, ok: false, code: 'already_exists' }] });
    }
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'dest', 'f.txt'), 'utf8')).toBe('old');
  });

  test('overwrite replaces a file but never a directory', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'f.txt'), 'new');
    writeFileSync(join(dir, 'dest', 'f.txt'), 'old');
    writeFileSync(join(dir, 'g'), 'g');
    mkdirSync(join(dir, 'dest', 'g'));
    mkdirSync(join(dir, 'd'));
    mkdirSync(join(dir, 'dest', 'd'));
    const paths = ['f.txt', 'g', 'd'].map((name) => join(dir, name));

    const { json } = await move({
      rootId,
      paths,
      destDir: join(dir, 'dest'),
      onConflict: 'overwrite',
    });

    expect(json).toEqual({
      results: [
        { path: paths[0], ok: true, dest: join(dir, 'dest', 'f.txt') },
        { path: paths[1], ok: false, code: 'already_exists' },
        { path: paths[2], ok: false, code: 'already_exists' },
      ],
    });
    expect(readFileSync(join(dir, 'dest', 'f.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'g'))).toBe(true);
    expect(existsSync(join(dir, 'd'))).toBe(true);
  });

  test('symlinks are moved as links, never followed', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'real.txt'), 'real');
    symlinkSync('real.txt', join(dir, 'ln'));
    const path = join(dir, 'ln');

    const { json } = await move({ rootId, paths: [path], destDir: join(dir, 'dest') });

    expect(json).toEqual({ results: [{ path, ok: true, dest: join(dir, 'dest', 'ln') }] });
    expect(lstatSync(join(dir, 'dest', 'ln')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'dest', 'ln'))).toBe('real.txt');
    expect(readFileSync(join(dir, 'real.txt'), 'utf8')).toBe('real');
  });

  test('a source below a symlinked parent that leaves the root is outside_roots', async () => {
    const { dir, rootId } = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside.dir, 'secret'), 's');
    symlinkSync(outside.dir, join(dir, 'link'));
    const path = join(dir, 'link', 'secret');

    const { json } = await move({ rootId, paths: [path], destDir: join(dir, 'dest') });

    expect(json).toEqual({ results: [{ path, ok: false, code: 'outside_roots' }] });
    expect(existsSync(join(outside.dir, 'secret'))).toBe(true);
  });

  test('moves across two roots of the same device', async () => {
    const a = sandbox();
    const b = sandbox(a.deviceId);
    writeFileSync(join(a.dir, 'f.txt'), 'x');
    const path = join(a.dir, 'f.txt');

    const { status, json } = await move({
      rootId: a.rootId,
      paths: [path],
      destRootId: b.rootId,
      destDir: join(b.dir, 'dest'),
    });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [{ path, ok: true, dest: join(b.dir, 'dest', 'f.txt') }],
    });
    expect(readFileSync(join(b.dir, 'dest', 'f.txt'), 'utf8')).toBe('x');
    expect(existsSync(path)).toBe(false);
  });

  test('roots on different devices are rejected with invalid / cross_device', async () => {
    const a = sandbox();
    const b = sandbox();
    writeFileSync(join(a.dir, 'f.txt'), 'x');

    const { status, json } = await move({
      rootId: a.rootId,
      paths: [join(a.dir, 'f.txt')],
      destRootId: b.rootId,
      destDir: join(b.dir, 'dest'),
    });

    expect(status).toBe(400);
    expect(json).toEqual(errorBody('invalid', 'cross_device'));
    expect(existsSync(join(a.dir, 'f.txt'))).toBe(true);
  });

  test('destination directory problems are request-level errors', async () => {
    const { dir, rootId } = sandbox();
    const outside = sandbox();
    writeFileSync(join(dir, 'f.txt'), 'x');
    symlinkSync(outside.dir, join(dir, 'esc'));
    const paths = [join(dir, 'f.txt')];
    const attempt = (destDir: string) => move({ rootId, paths, destDir });

    expect(await attempt(join(dir, 'nope'))).toEqual({
      status: 404,
      json: errorBody('not_found'),
    });
    expect(await attempt(join(dir, 'f.txt'))).toEqual({
      status: 400,
      json: errorBody('not_a_directory'),
    });
    expect(await attempt(join(dir, 'esc'))).toEqual({
      status: 403,
      json: errorBody('outside_roots'),
    });
    expect(await attempt(join(dir, '..'))).toEqual({
      status: 403,
      json: errorBody('outside_roots'),
    });
    expect(existsSync(join(dir, 'f.txt'))).toBe(true);
  });

  test('unknown root and unknown destination root', async () => {
    const { dir, rootId } = sandbox();
    const paths = [join(dir, 'x')];

    expect(await move({ rootId: 'no-such-root', paths, destDir: dir })).toEqual({
      status: 404,
      json: errorBody('root_not_found'),
    });
    expect(await move({ rootId, paths, destRootId: 'no-such-root', destDir: dir })).toEqual({
      status: 404,
      json: errorBody('root_not_found'),
    });
  });

  test('body validation returns 400 invalidRequest', async () => {
    const { dir, rootId } = sandbox();
    const valid = { rootId, paths: [join(dir, 'a')], destDir: join(dir, 'dest') };
    const bad: unknown[] = [
      null,
      [],
      { ...valid, rootId: '' },
      { ...valid, rootId: 3 },
      { ...valid, paths: [] },
      { ...valid, paths: 'nope' },
      { ...valid, paths: ['relative/path'] },
      { ...valid, paths: [`${dir}/nul\0seg`] },
      { ...valid, paths: [5] },
      { ...valid, paths: Array.from({ length: 501 }, (_, i) => join(dir, `f${i}`)) },
      { ...valid, destDir: 'relative' },
      { ...valid, destDir: undefined },
      { ...valid, destRootId: '' },
      { ...valid, destRootId: 7 },
      { ...valid, onConflict: 'merge' },
    ];

    for (const body of bad) {
      const { status, json } = await move(body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: t('apiError.invalidRequest') });
    }
  });
});
