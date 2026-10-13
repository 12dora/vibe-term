import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileMoveIo, moveLocal } from './move-local';
import type { MoveBatch, MoveOutcome } from './move-types';

const sandboxes: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-local-')));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dest'));
  return dir;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function batch(
  dir: string,
  names: Array<[string, string?]>,
  over: Partial<MoveBatch> = {}
): MoveBatch {
  return {
    rootPath: dir,
    destRootPath: dir,
    destDir: join(dir, 'dest'),
    overwrite: false,
    items: names.map(([name, destName]) => ({
      path: join(dir, name),
      parent: dir,
      name,
      destName: destName ?? name,
    })),
    ...over,
  };
}

async function run(b: MoveBatch): Promise<MoveOutcome[]> {
  const result = await moveLocal('move-local-test-device', b);
  if (!result.ok) throw new Error(`request failed: ${result.code}`);
  return result.data;
}

function code(outcome: MoveOutcome | undefined): string {
  if (!outcome) return 'missing';
  return outcome.ok ? 'ok' : outcome.code;
}

describe('moveLocal', () => {
  test('renames files and directories in place', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f.txt'), 'f');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner.txt'), 'inner');

    const outcomes = await run(batch(dir, [['f.txt'], ['d']]));

    expect(outcomes.map(code)).toEqual(['ok', 'ok']);
    expect(readFileSync(join(dir, 'dest', 'f.txt'), 'utf8')).toBe('f');
    expect(readFileSync(join(dir, 'dest', 'd', 'inner.txt'), 'utf8')).toBe('inner');
    expect(existsSync(join(dir, 'f.txt'))).toBe(false);
  });

  test('same parent and name is a no-op, same parent new name renames', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'a'), 'a');
    const noop = await run(batch(dir, [['a']], { destDir: dir }));
    expect(noop.map(code)).toEqual(['ok']);
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('a');

    const renamed = await run(batch(dir, [['a', 'b']], { destDir: dir }));
    expect(renamed.map(code)).toEqual(['ok']);
    expect(existsSync(join(dir, 'a'))).toBe(false);
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('a');
  });

  test('a directory cannot move into itself or any descendant, even via symlink', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
    symlinkSync(join(dir, 'd', 'sub'), join(dir, 'dest', 'to-sub'));
    const moveDInto = async (destDir: string) => {
      const outcomes = await run(batch(dir, [['d']], { destDir }));
      return code(outcomes[0]);
    };

    expect(await moveDInto(join(dir, 'd'))).toBe('invalid');
    expect(await moveDInto(join(dir, 'd', 'sub'))).toBe('invalid');
    expect(await moveDInto(join(dir, 'dest', 'to-sub'))).toBe('invalid');
    expect(existsSync(join(dir, 'd', 'sub'))).toBe(true);
  });

  test('conflicts fail by default and overwrite only replaces non-directories', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    mkdirSync(join(dir, 'd'));
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'g'), 'g');
    mkdirSync(join(dir, 'dest', 'g'));
    mkdirSync(join(dir, 'h'));
    writeFileSync(join(dir, 'dest', 'h'), 'h');

    const failing = await run(batch(dir, [['f']]));
    expect(failing.map(code)).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');

    const over = await run(batch(dir, [['f'], ['d'], ['g'], ['h']], { overwrite: true }));
    expect(over.map(code)).toEqual(['ok', 'already_exists', 'already_exists', 'already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'd'))).toBe(true);
    expect(existsSync(join(dir, 'g'))).toBe(true);
    expect(existsSync(join(dir, 'h'))).toBe(true);
  });

  test('overwrite replaces an existing symlink without touching its target', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    writeFileSync(join(dir, 'f'), 'new');

    const outcomes = await run(batch(dir, [['f']], { overwrite: true }));

    expect(outcomes.map(code)).toEqual(['ok']);
    expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(dir, 'target'))).toEqual([]);
  });

  test('symlinks move as links', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync('real', join(dir, 'ln'));
    symlinkSync(join(dir, 'dest'), join(dir, 'dirln'));

    const outcomes = await run(batch(dir, [['ln'], ['dirln']]));

    expect(outcomes.map(code)).toEqual(['ok', 'ok']);
    expect(readlinkSync(join(dir, 'dest', 'ln'))).toBe('real');
    expect(lstatSync(join(dir, 'dest', 'dirln')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'real'), 'utf8')).toBe('x');
  });

  test('missing sources and escaping parents are reported per item', async () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, 'secret'), 's');
    symlinkSync(outside, join(dir, 'link'));
    writeFileSync(join(dir, 'ok.txt'), 'ok');
    const b = batch(dir, [['ghost'], ['ok.txt']]);
    b.items.push({
      path: join(dir, 'link', 'secret'),
      parent: join(dir, 'link'),
      name: 'secret',
      destName: 'secret',
    });

    const outcomes = await run(b);

    expect(outcomes.map(code)).toEqual(['not_found', 'ok', 'outside_roots']);
    expect(existsSync(join(outside, 'secret'))).toBe(true);
  });

  test('request-level destination errors', async () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(dir, 'file'), 'x');
    symlinkSync(outside, join(dir, 'esc'));
    const fails = async (over: Partial<MoveBatch>) => {
      const result = await moveLocal('move-local-test-device', batch(dir, [['file']], over));
      return result.ok ? 'ok' : result.code;
    };

    expect(await fails({ destDir: join(dir, 'nope') })).toBe('not_found');
    expect(await fails({ destDir: join(dir, 'file') })).toBe('not_a_directory');
    expect(await fails({ destDir: join(dir, 'esc') })).toBe('outside_roots');
    expect(await fails({ rootPath: join(dir, 'gone') })).toBe('root_not_found');
    expect(existsSync(join(dir, 'file'))).toBe(true);
  });

  test('cross-root moves on the same device', async () => {
    const a = sandbox();
    const b = sandbox();
    writeFileSync(join(a, 'f'), 'x');

    const outcomes = await run(batch(a, [['f']], { destRootPath: b, destDir: join(b, 'dest') }));

    expect(outcomes.map(code)).toEqual(['ok']);
    expect(readFileSync(join(b, 'dest', 'f'), 'utf8')).toBe('x');
  });
});

describe('moveLocal EXDEV fallback', () => {
  function stubRenameExdev() {
    const spy = spyOn(fileMoveIo, 'rename').mockImplementation(() => {
      throw errno('EXDEV');
    });
    spies.push(spy);
    return spy;
  }

  test('copies then removes the source for files, directories and symlinks', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'file');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    symlinkSync('inner', join(dir, 'd', 'ln'));
    const spy = stubRenameExdev();

    const outcomes = await run(batch(dir, [['f'], ['d']]));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(outcomes.map(code)).toEqual(['ok', 'ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('file');
    expect(readFileSync(join(dir, 'dest', 'd', 'inner'), 'utf8')).toBe('inner');
    expect(readlinkSync(join(dir, 'dest', 'd', 'ln'))).toBe('inner');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(existsSync(join(dir, 'd'))).toBe(false);
  });

  test('overwrite goes through the copy path too', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    stubRenameExdev();

    const outcomes = await run(batch(dir, [['f']], { overwrite: true }));

    expect(outcomes.map(code)).toEqual(['ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'f'))).toBe(false);
  });

  test('a failed copy removes the partial destination and keeps the source', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    stubRenameExdev();
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation((_src, dest) => {
        mkdirSync(String(dest));
        writeFileSync(join(String(dest), 'partial'), 'p');
        throw errno('EACCES');
      })
    );

    const outcomes = await run(batch(dir, [['d']]));

    expect(outcomes.map(code)).toEqual(['permission_denied']);
    expect(existsSync(join(dir, 'dest', 'd'))).toBe(false);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
  });

  test('a failed copy over an existing destination keeps that destination', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    stubRenameExdev();
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation(() => {
        throw errno('ENOSPC');
      })
    );

    const outcomes = await run(batch(dir, [['f']], { overwrite: true }));

    expect(outcomes.map(code)).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('rename races surface as already_exists', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'x');
    spies.push(
      spyOn(fileMoveIo, 'rename').mockImplementation(() => {
        throw errno('ENOTEMPTY');
      })
    );

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['already_exists']);
  });
});
