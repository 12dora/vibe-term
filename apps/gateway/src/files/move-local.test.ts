import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

const isTemp = (path: unknown) => basename(String(path)).startsWith('.vtmv-');

describe('moveLocal EXDEV fallback', () => {
  /** 模拟目标在另一个文件系统：源→目标的 rename / link 报 EXDEV，临时项→目标（同目录）照常。 */
  function stubCrossDevice() {
    const rename = spyOn(fileMoveIo, 'rename').mockImplementation((from, to) => {
      if (!isTemp(from)) throw errno('EXDEV');
      renameSync(from, to);
    });
    const link = spyOn(fileMoveIo, 'link').mockImplementation((from, to) => {
      if (!isTemp(from)) throw errno('EXDEV');
      linkSync(from, to);
    });
    spies.push(rename, link);
    return rename;
  }

  function leftovers(dir: string): string[] {
    return readdirSync(join(dir, 'dest')).filter((name) => name.startsWith('.vtmv-'));
  }

  test('copies then removes the source for files, directories and symlinks', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'file');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    symlinkSync('inner', join(dir, 'd', 'ln'));
    symlinkSync('f', join(dir, 'lnk'));
    const spy = stubCrossDevice();

    const outcomes = await run(batch(dir, [['f'], ['d'], ['lnk']]));

    expect(spy).toHaveBeenCalled();
    expect(outcomes.map(code)).toEqual(['ok', 'ok', 'ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('file');
    expect(readFileSync(join(dir, 'dest', 'd', 'inner'), 'utf8')).toBe('inner');
    expect(readlinkSync(join(dir, 'dest', 'd', 'ln'))).toBe('inner');
    expect(readlinkSync(join(dir, 'dest', 'lnk'))).toBe('f');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(existsSync(join(dir, 'd'))).toBe(false);
    expect(lstatSync(join(dir, 'lnk'), { throwIfNoEntry: false })).toBeUndefined();
    expect(leftovers(dir)).toEqual([]);
    expect(readdirSync(join(dir, 'dest')).sort()).toEqual(['d', 'f', 'lnk']);
  });

  test('overwrite goes through the copy path too', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    stubCrossDevice();

    const outcomes = await run(batch(dir, [['f']], { overwrite: true }));

    expect(outcomes.map(code)).toEqual(['ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failed copy removes only its temporary sibling and keeps the source', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    stubCrossDevice();
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation((_src, tmp) => {
        expect(isTemp(tmp)).toBe(true);
        mkdirSync(String(tmp));
        writeFileSync(join(String(tmp), 'partial'), 'p');
        throw errno('EACCES');
      })
    );

    const outcomes = await run(batch(dir, [['d']]));

    expect(outcomes.map(code)).toEqual(['permission_denied']);
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
  });

  test('a destination created concurrently survives a failed copy', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    stubCrossDevice();
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation((_src, tmp) => {
        mkdirSync(String(tmp));
        // 别人在复制期间建出了最终目标
        mkdirSync(join(dir, 'dest', 'd'));
        writeFileSync(join(dir, 'dest', 'd', 'theirs'), 'theirs');
        throw errno('ENOSPC');
      })
    );

    const outcomes = await run(batch(dir, [['d']]));

    expect(outcomes.map(code)).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'dest', 'd', 'theirs'), 'utf8')).toBe('theirs');
    expect(leftovers(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
  });

  test('a destination created during the copy is not replaced at commit time', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'mine');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    stubCrossDevice();
    const realCp = fileMoveIo.cp;
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation((src, tmp, options) => {
        realCp(src, tmp, options);
        // 复制期间别人建出了同名目标
        if (basename(String(src)) === 'f') {
          writeFileSync(join(dir, 'dest', 'f'), 'theirs');
          return;
        }
        mkdirSync(join(dir, 'dest', 'd'));
        writeFileSync(join(dir, 'dest', 'd', 'theirs'), 'theirs');
      })
    );

    const outcomes = await run(batch(dir, [['f'], ['d']]));

    expect(outcomes.map(code)).toEqual(['already_exists', 'already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual(['theirs']);
    expect(leftovers(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('mine');
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
  });

  test('a failed copy over an existing destination keeps that destination', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    stubCrossDevice();
    spies.push(
      spyOn(fileMoveIo, 'cp').mockImplementation(() => {
        throw errno('ENOSPC');
      })
    );

    const outcomes = await run(batch(dir, [['f']], { overwrite: true }));

    expect(outcomes.map(code)).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(leftovers(dir)).toEqual([]);
  });

  test('a source that cannot be removed leaves the committed destination in place', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    stubCrossDevice();
    spies.push(
      spyOn(fileMoveIo, 'rm').mockImplementation((path, options) => {
        if (String(path) === join(dir, 'f')) throw errno('EACCES');
        rmSync(path, options);
      })
    );

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['permission_denied']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('data');
    expect(leftovers(dir)).toEqual([]);
  });

  test('rename races surface as already_exists', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    spies.push(
      spyOn(fileMoveIo, 'rename').mockImplementation(() => {
        throw errno('ENOTEMPTY');
      })
    );

    const outcomes = await run(batch(dir, [['d']]));

    expect(outcomes.map(code)).toEqual(['already_exists']);
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(existsSync(join(dir, 'd'))).toBe(true);
  });
});

describe('moveLocal no-replace on one file system', () => {
  /** 让预检的 lstat 看到「目标不存在」，等价于预检之后目标才被别人建出来。 */
  function foolPrecheck(missing: string[]) {
    const realLstat = lstatSync;
    spies.push(
      spyOn(fileMoveIo, 'lstat').mockImplementation(((...args: Parameters<typeof lstatSync>) => {
        if (missing.includes(String(args[0]))) throw errno('ENOENT');
        return realLstat(...args);
      }) as typeof lstatSync)
    );
  }

  test('a file never replaces a destination that appeared after the check', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    foolPrecheck([join(dir, 'dest', 'f')]);

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('a directory never replaces a destination that appeared after the check', async () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'dest', 'd', 'keep'), 'keep');
    foolPrecheck([join(dir, 'dest', 'd')]);

    const outcomes = await run(batch(dir, [['d']]));

    expect(outcomes.map(code)).toEqual(['already_exists']);
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual(['keep']);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
  });

  test('rename onto a sibling that appeared after the check keeps both', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'a'), 'a');
    writeFileSync(join(dir, 'b'), 'b');
    foolPrecheck([join(dir, 'b')]);

    const outcomes = await run(batch(dir, [['a', 'b']], { destDir: dir }));

    expect(outcomes.map(code)).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('b');
  });

  test('file systems without hard links fall back to a checked rename', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    spies.push(
      spyOn(fileMoveIo, 'link').mockImplementation(() => {
        throw errno('EPERM');
      })
    );

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    expect(existsSync(join(dir, 'f'))).toBe(false);
  });

  test('a failed unlink after linking keeps the new link and reports the error', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    const unlink = spyOn(fileMoveIo, 'unlink').mockImplementation(() => {
      throw errno('EACCES');
    });
    spies.push(unlink);

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['permission_denied']);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('data');
  });

  test('a destination swapped in before the failed unlink is never deleted', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    spies.push(
      spyOn(fileMoveIo, 'unlink').mockImplementation(() => {
        // 别的进程在 link 与 unlink 之间把 dest 换成了它们的文件
        rmSync(join(dir, 'dest', 'f'));
        writeFileSync(join(dir, 'dest', 'f'), 'theirs');
        throw errno('EACCES');
      })
    );

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['permission_denied']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('data');
  });

  test('a retry after a committed link finishes the move in fail and overwrite modes', async () => {
    for (const overwrite of [false, true]) {
      const dir = sandbox();
      writeFileSync(join(dir, 'f'), 'data');
      linkSync(join(dir, 'f'), join(dir, 'dest', 'f'));

      const outcomes = await run(batch(dir, [['f']], { overwrite }));

      expect(outcomes.map(code)).toEqual(['ok']);
      expect(existsSync(join(dir, 'f'))).toBe(false);
      expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    }
  });

  test('a real retry after the failed unlink completes instead of already_exists', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    const unlink = spyOn(fileMoveIo, 'unlink').mockImplementationOnce(() => {
      throw errno('EACCES');
    });
    spies.push(unlink);

    const first = await run(batch(dir, [['f']]));
    const retry = await run(batch(dir, [['f']]));

    expect(first.map(code)).toEqual(['permission_denied']);
    expect(retry.map(code)).toEqual(['ok']);
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
  });

  test('different files with equal names are still a conflict', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    const outcomes = await run(batch(dir, [['f']]));

    expect(outcomes.map(code)).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });
});
