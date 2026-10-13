import { describe, expect, test } from 'bun:test';
import type { FileEntryDto, ListFilesResponse } from '@vibeterm/shared';
import {
  CLOSED_FILE_OPS_STATE,
  createFileOpsRequestStore,
  listingNames,
  nameRequestDir,
  namesOrEmpty,
} from './file-ops-requests';

function entry(name: string, type: FileEntryDto['type'] = 'file'): FileEntryDto {
  return {
    name,
    path: `/srv/${name}`,
    type,
    category: type === 'dir' ? 'directory' : 'text',
    size: null,
    modifiedAt: null,
    isSymlink: false,
  };
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

describe('createFileOpsRequestStore', () => {
  test('初始为关闭态', () => {
    expect(createFileOpsRequestStore().get()).toBe(CLOSED_FILE_OPS_STATE);
  });

  test('三种请求各自落成对应的 request 并打开', () => {
    const store = createFileOpsRequestStore();
    store.requestNewFolder('r1', '/srv');
    expect(store.get()).toEqual({
      open: true,
      request: { kind: 'newFolder', rootId: 'r1', dir: '/srv' },
    });

    store.requestRename('r1', '/srv/a.txt', 'a.txt', false);
    expect(store.get()).toEqual({
      open: true,
      request: { kind: 'rename', rootId: 'r1', path: '/srv/a.txt', name: 'a.txt', isDir: false },
    });

    store.requestDelete('r1', [{ path: '/srv/a.txt', name: 'a.txt' }]);
    expect(store.get()).toEqual({
      open: true,
      request: { kind: 'delete', rootId: 'r1', entries: [{ path: '/srv/a.txt', name: 'a.txt' }] },
    });
  });

  test('关闭后保留上一条请求（退场动画期间内容不消失）', () => {
    const store = createFileOpsRequestStore();
    store.requestRename('r1', '/srv/docs', 'docs', true);
    const { request } = store.get();
    store.close();
    expect(store.get()).toEqual({ open: false, request });
  });

  test('空的删除请求不打开对话框', () => {
    const store = createFileOpsRequestStore();
    store.requestDelete('r1', []);
    expect(store.get()).toBe(CLOSED_FILE_OPS_STATE);
  });

  test('订阅者在请求与关闭时各收到一次通知，重复关闭不再通知', () => {
    const store = createFileOpsRequestStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.requestNewFolder('r1', '/srv');
    store.close();
    store.close();
    expect(calls).toBe(2);
    unsubscribe();
    store.requestNewFolder('r1', '/srv');
    expect(calls).toBe(2);
  });
});

describe('listingNames', () => {
  test('没有缓存时为 undefined', () => {
    expect(listingNames(undefined)).toBeUndefined();
    expect(namesOrEmpty(undefined).size).toBe(0);
  });

  test('收集目录里全部条目的名称（文件与目录都算）', () => {
    const listing: ListFilesResponse = {
      path: '/srv',
      entries: [entry('a.txt'), entry('docs', 'dir')],
      truncated: false,
    };
    const names = listingNames(listing);
    expect(names).toEqual(new Set(['a.txt', 'docs']));
    expect(namesOrEmpty(names)).toBe(names as Set<string>);
  });
});

describe('nameRequestDir', () => {
  test('新建看目标目录，重命名看上级目录，其余为 null', () => {
    expect(nameRequestDir({ kind: 'newFolder', rootId: 'r1', dir: '/srv/docs' }, parentOf)).toBe(
      '/srv/docs'
    );
    expect(
      nameRequestDir(
        { kind: 'rename', rootId: 'r1', path: '/srv/docs/a.txt', name: 'a.txt', isDir: false },
        parentOf
      )
    ).toBe('/srv/docs');
    expect(nameRequestDir({ kind: 'delete', rootId: 'r1', entries: [] }, parentOf)).toBeNull();
    expect(nameRequestDir(null, parentOf)).toBeNull();
  });
});
