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
import { cleanupMoveTest, errorBody, rename, sandbox } from './file-move-test-utils';

beforeAll(() => {
  runMigrations();
});

afterEach(cleanupMoveTest);

describe('POST /api/files/rename (local)', () => {
  test('renames a file and a directory', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'old.txt'), 'x');
    mkdirSync(join(dir, 'olddir'));

    const file = await rename({ rootId, path: join(dir, 'old.txt'), name: 'new.txt' });
    const folder = await rename({ rootId, path: join(dir, 'olddir'), name: '新 目录' });

    expect(file).toEqual({ status: 200, json: { path: join(dir, 'new.txt') } });
    expect(folder).toEqual({ status: 200, json: { path: join(dir, '新 目录') } });
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    expect(lstatSync(join(dir, '新 目录')).isDirectory()).toBe(true);
  });

  test('renames inside a nested directory and accepts a leading dash', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'dest', 'a'), 'x');

    const { status, json } = await rename({ rootId, path: join(dir, 'dest', 'a'), name: '-b' });

    expect(status).toBe(200);
    expect(json).toEqual({ path: join(dir, 'dest', '-b') });
    expect(existsSync(join(dir, 'dest', '-b'))).toBe(true);
  });

  test('invalid names are rejected with invalid', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a'), 'x');
    const tooLongBytes = '界'.repeat(86);
    const names = ['', '.', '..', 'x/y', 'x\\y', 'x\0y', 'x'.repeat(256), tooLongBytes];

    for (const name of names) {
      const { status, json } = await rename({ rootId, path: join(dir, 'a'), name });
      expect(status).toBe(400);
      expect(json).toEqual(errorBody('invalid'));
    }
    expect(existsSync(join(dir, 'a'))).toBe(true);
  });

  test('a 255 byte name is accepted', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a'), 'x');
    const name = 'n'.repeat(255);

    const { status, json } = await rename({ rootId, path: join(dir, 'a'), name });

    expect(status).toBe(200);
    expect(json).toEqual({ path: join(dir, name) });
  });

  test('an existing target is already_exists and nothing changes', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a'), 'a');
    writeFileSync(join(dir, 'b'), 'b');
    mkdirSync(join(dir, 'c'));

    for (const name of ['b', 'c']) {
      const { status, json } = await rename({ rootId, path: join(dir, 'a'), name });
      expect(status).toBe(409);
      expect(json).toEqual(errorBody('already_exists'));
    }
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('b');
  });

  test('the same name returns the unchanged path', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'a'), 'a');

    const { status, json } = await rename({ rootId, path: join(dir, 'a'), name: 'a' });

    expect(status).toBe(200);
    expect(json).toEqual({ path: join(dir, 'a') });
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('a');
  });

  test('renaming the root itself is invalid, outside paths are outside_roots', async () => {
    const { dir, rootId } = sandbox();

    expect(await rename({ rootId, path: dir, name: 'x' })).toEqual({
      status: 400,
      json: errorBody('invalid'),
    });
    expect(await rename({ rootId, path: join(dir, '..', 'x'), name: 'y' })).toEqual({
      status: 403,
      json: errorBody('outside_roots'),
    });
  });

  test('a missing source is not_found and an unknown root is root_not_found', async () => {
    const { dir, rootId } = sandbox();

    expect(await rename({ rootId, path: join(dir, 'ghost'), name: 'x' })).toEqual({
      status: 404,
      json: errorBody('not_found'),
    });
    expect(await rename({ rootId: 'no-such-root', path: join(dir, 'a'), name: 'x' })).toEqual({
      status: 404,
      json: errorBody('root_not_found'),
    });
  });

  test('a symlink is renamed as a link', async () => {
    const { dir, rootId } = sandbox();
    writeFileSync(join(dir, 'real'), 'r');
    symlinkSync('real', join(dir, 'ln'));

    const { status } = await rename({ rootId, path: join(dir, 'ln'), name: 'ln2' });

    expect(status).toBe(200);
    expect(readlinkSync(join(dir, 'ln2'))).toBe('real');
    expect(readFileSync(join(dir, 'real'), 'utf8')).toBe('r');
  });

  test('body validation returns 400 invalidRequest', async () => {
    const { dir, rootId } = sandbox();
    const valid = { rootId, path: join(dir, 'a'), name: 'b' };
    const bad: unknown[] = [
      null,
      [],
      { ...valid, rootId: '' },
      { ...valid, path: 'relative' },
      { ...valid, path: `${dir}/n\0` },
      { ...valid, name: undefined },
      { ...valid, name: 5 },
    ];

    for (const body of bad) {
      const { status, json } = await rename(body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: t('apiError.invalidRequest') });
    }
  });
});
