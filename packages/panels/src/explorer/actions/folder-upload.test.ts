import { describe, expect, test } from 'bun:test';
import {
  type DroppedDirectoryEntry,
  type DroppedEntry,
  type DroppedFileEntry,
  FOLDER_UPLOAD_MAX_DEPTH,
  FOLDER_UPLOAD_MAX_FILES,
  FolderUploadLimitError,
  type FolderUploadPlan,
  collectDroppedItems,
  filesFromDirectoryInput,
  sortDirsParentsFirst,
} from './folder-upload';

function fakeFile(name: string, webkitRelativePath = ''): File {
  return { name, size: 1, webkitRelativePath } as unknown as File;
}

function fileEntry(name: string): DroppedFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onSuccess) => queueMicrotask(() => onSuccess(fakeFile(name))),
  };
}

function brokenFileEntry(name: string): DroppedFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (_onSuccess, onError) => queueMicrotask(() => onError?.(new Error('unreadable'))),
  };
}

/** `batchSize` 模拟 Chromium 的分批：每次 readEntries 只吐一批，读完后回空数组 */
function dirEntry(
  name: string,
  children: DroppedEntry[],
  batchSize = 100,
  calls?: { count: number }
): DroppedDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (onSuccess) => {
          if (calls) calls.count += 1;
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          queueMicrotask(() => onSuccess(batch));
        },
      };
    },
  };
}

interface FakeItem {
  kind: string;
  webkitGetAsEntry?: () => DroppedEntry | null;
  getAsFile: () => File | null;
}

function entryItem(entry: DroppedEntry | null, file: File | null = null): FakeItem {
  return { kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => file };
}

function fakeDrop(items: FakeItem[] | undefined, files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

const shape = (plan: FolderUploadPlan) => ({
  files: plan.files.map(({ file, relDir }) => `${relDir}|${file.name}`),
  dirs: plan.dirs,
});

describe('collectDroppedItems', () => {
  test('walks nested folders and keeps empty directories', async () => {
    const tree = dirEntry('proj', [
      fileEntry('readme.md'),
      dirEntry('src', [fileEntry('a.ts'), dirEntry('deep', [fileEntry('b.ts')])]),
      dirEntry('empty', []),
    ]);
    const plan = await collectDroppedItems(
      fakeDrop([entryItem(tree), entryItem(fileEntry('top'))])
    );
    expect(shape(plan)).toEqual({
      files: ['proj|readme.md', 'proj/src|a.ts', 'proj/src/deep|b.ts', '|top'],
      dirs: ['proj', 'proj/empty', 'proj/src', 'proj/src/deep'],
    });
  });

  test('keeps calling readEntries until an empty batch', async () => {
    const calls = { count: 0 };
    const children = Array.from({ length: 5 }, (_, i) => fileEntry(`f${i}`));
    const plan = await collectDroppedItems(
      fakeDrop([entryItem(dirEntry('many', children, 2, calls))])
    );
    expect(plan.files.map((item) => item.file.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(plan.files.every((item) => item.relDir === 'many')).toBe(true);
    // 2 + 2 + 1 + 空批
    expect(calls.count).toBe(4);
  });

  test('captures entries synchronously, before the DataTransfer is neutered', async () => {
    const items = [entryItem(dirEntry('a', [fileEntry('x')]))];
    const dt = fakeDrop(items);
    const pending = collectDroppedItems(dt);
    // 浏览器在 drop 回调返回后清空 DataTransfer
    items.length = 0;
    expect(shape(await pending)).toEqual({ files: ['a|x'], dirs: ['a'] });
  });

  test('ignores non-file items and falls back to getAsFile when an item has no entry', async () => {
    const loose = fakeFile('loose.bin');
    const plan = await collectDroppedItems(
      fakeDrop([
        { kind: 'string', getAsFile: () => null },
        entryItem(null, loose),
        { kind: 'file', getAsFile: () => fakeFile('legacy.txt') },
      ])
    );
    expect(shape(plan)).toEqual({ files: ['|loose.bin', '|legacy.txt'], dirs: [] });
  });

  test('falls back to dt.files when the entry API is unavailable', async () => {
    const files = [fakeFile('a'), fakeFile('b')];
    expect(shape(await collectDroppedItems(fakeDrop(undefined, files)))).toEqual({
      files: ['|a', '|b'],
      dirs: [],
    });
    expect(shape(await collectDroppedItems(fakeDrop([], files))).files).toEqual(['|a', '|b']);
  });

  test('rejects with a typed error past the file cap', async () => {
    const children = Array.from({ length: FOLDER_UPLOAD_MAX_FILES + 1 }, (_, i) =>
      fileEntry(`f${i}`)
    );
    const error = await collectDroppedItems(
      fakeDrop([entryItem(dirEntry('huge', children, 1000))])
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FolderUploadLimitError);
    expect((error as FolderUploadLimitError).limit).toBe('tooManyFiles');
    expect((error as FolderUploadLimitError).folderName).toBe('huge');
  });

  test('exactly the file cap is accepted', async () => {
    const children = Array.from({ length: FOLDER_UPLOAD_MAX_FILES }, (_, i) => fileEntry(`f${i}`));
    const plan = await collectDroppedItems(fakeDrop([entryItem(dirEntry('big', children, 1000))]));
    expect(plan.files).toHaveLength(FOLDER_UPLOAD_MAX_FILES);
  });

  function chain(depth: number): DroppedEntry {
    let node: DroppedEntry = dirEntry(`d${depth}`, [fileEntry('leaf')]);
    for (let level = depth - 1; level >= 1; level -= 1) node = dirEntry(`d${level}`, [node]);
    return node;
  }

  test('depth cap: 32 levels pass, 33 reject naming the top folder', async () => {
    const ok = await collectDroppedItems(fakeDrop([entryItem(chain(FOLDER_UPLOAD_MAX_DEPTH))]));
    expect(ok.dirs).toHaveLength(FOLDER_UPLOAD_MAX_DEPTH);
    expect(ok.files).toHaveLength(1);

    const error = await collectDroppedItems(
      fakeDrop([entryItem(chain(FOLDER_UPLOAD_MAX_DEPTH + 1))])
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FolderUploadLimitError);
    expect((error as FolderUploadLimitError).limit).toBe('tooDeep');
    expect((error as FolderUploadLimitError).folderName).toBe('d1');
  });

  test('a read failure rejects instead of silently dropping files', async () => {
    const pending = collectDroppedItems(
      fakeDrop([entryItem(dirEntry('a', [brokenFileEntry('x')]))])
    );
    await expect(pending).rejects.toThrow('unreadable');
  });
});

describe('filesFromDirectoryInput', () => {
  test('rebuilds directories from webkitRelativePath', () => {
    const plan = filesFromDirectoryInput([
      fakeFile('a.ts', 'proj/src/a.ts'),
      fakeFile('readme.md', 'proj/readme.md'),
      fakeFile('b.ts', 'proj/src/deep/b.ts'),
    ]);
    expect(shape(plan)).toEqual({
      files: ['proj/src|a.ts', 'proj|readme.md', 'proj/src/deep|b.ts'],
      dirs: ['proj', 'proj/src', 'proj/src/deep'],
    });
  });

  test('files without a relative path land at the top level', () => {
    const plan = filesFromDirectoryInput([fakeFile('solo.txt'), fakeFile('x', 'x')]);
    expect(shape(plan)).toEqual({ files: ['|solo.txt', '|x'], dirs: [] });
  });

  test('drops empty, "." and ".." segments', () => {
    const plan = filesFromDirectoryInput([fakeFile('a', '../proj//./sub/a')]);
    expect(shape(plan)).toEqual({ files: ['proj/sub|a'], dirs: ['proj', 'proj/sub'] });
  });

  test('caps', () => {
    const many = Array.from({ length: FOLDER_UPLOAD_MAX_FILES + 1 }, (_, i) =>
      fakeFile(`f${i}`, `big/f${i}`)
    );
    expect(() => filesFromDirectoryInput(many)).toThrow(FolderUploadLimitError);
    expect(filesFromDirectoryInput(many.slice(0, FOLDER_UPLOAD_MAX_FILES)).files).toHaveLength(
      FOLDER_UPLOAD_MAX_FILES
    );

    const deepDirs = Array.from({ length: FOLDER_UPLOAD_MAX_DEPTH + 1 }, (_, i) => `d${i}`);
    try {
      filesFromDirectoryInput([fakeFile('leaf', `${deepDirs.join('/')}/leaf`)]);
      throw new Error('expected a limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(FolderUploadLimitError);
      expect((error as FolderUploadLimitError).limit).toBe('tooDeep');
      expect((error as FolderUploadLimitError).folderName).toBe('d0');
    }
  });
});

describe('sortDirsParentsFirst', () => {
  test('orders by depth, then by name', () => {
    expect(sortDirsParentsFirst(['b/x/y', 'b', 'a/z', 'a', 'b/x'])).toEqual([
      'a',
      'b',
      'a/z',
      'b/x',
      'b/x/y',
    ]);
  });
});
