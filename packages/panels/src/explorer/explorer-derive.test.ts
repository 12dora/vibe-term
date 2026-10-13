import { describe, expect, test } from 'bun:test';
import type { ExplorerClipboard } from '@vibeterm/stores';
import {
  childToReselect,
  clipboardItems,
  contentKindOf,
  cutPathsOf,
  destDisplayName,
  explorerStatus,
  listingNames,
  menuEntriesOf,
  primaryEntry,
  selectedBytesOf,
} from './explorer-derive';
import { dirEntry, fileEntry } from './test-fixtures';

const ENTRIES = [
  dirEntry('/root/docs'),
  fileEntry('/root/a.txt', 100),
  fileEntry('/root/b.txt', 250),
  fileEntry('/root/unknown.bin', null),
];

describe('selectedBytesOf', () => {
  test('全是已知大小的文件时求和', () => {
    expect(selectedBytesOf([ENTRIES[1], ENTRIES[2]])).toBe(350);
    expect(selectedBytesOf([fileEntry('/root/empty', 0)])).toBe(0);
  });

  test('含目录或大小未知的项时为 null', () => {
    expect(selectedBytesOf([ENTRIES[0], ENTRIES[1]])).toBeNull();
    expect(selectedBytesOf([ENTRIES[1], ENTRIES[3]])).toBeNull();
  });

  test('指向目录的符号链接按目录算', () => {
    const link = dirEntry('/root/link');
    expect(selectedBytesOf([{ ...link, type: 'symlink', size: 12 }])).toBeNull();
  });

  test('没有选择时为 null', () => {
    expect(selectedBytesOf([])).toBeNull();
  });
});

describe('explorerStatus', () => {
  test('总数取可见条目，选中数只算仍可见的', () => {
    const selected = new Set(['/root/a.txt', '/root/b.txt', '/root/filtered-out.txt']);
    expect(explorerStatus(ENTRIES, selected, false)).toEqual({
      total: 4,
      selectedCount: 2,
      selectedBytes: 350,
      truncated: false,
    });
  });

  test('没有选择、列表被截断', () => {
    expect(explorerStatus(ENTRIES, new Set(), true)).toEqual({
      total: 4,
      selectedCount: 0,
      selectedBytes: null,
      truncated: true,
    });
  });
});

describe('childToReselect', () => {
  const at = (path: string, rootId = 'r1') => ({ rootId, path });

  test('回到上一级：选中刚才所在的文件夹', () => {
    expect(childToReselect(at('/root/docs'), at('/root'))).toBe('/root/docs');
  });

  test('一次回退多级：选中通向原位置的那个直接子目录', () => {
    expect(childToReselect(at('/root/docs/a/b'), at('/root'))).toBe('/root/docs');
    expect(childToReselect(at('/srv/app'), at('/'))).toBe('/srv');
  });

  test('进入子目录、平级跳转、原地不动、首次进入都不选', () => {
    expect(childToReselect(at('/root'), at('/root/docs'))).toBeNull();
    expect(childToReselect(at('/root/docs'), at('/root/docs-2'))).toBeNull();
    expect(childToReselect(at('/root'), at('/root'))).toBeNull();
    expect(childToReselect(null, at('/root'))).toBeNull();
  });

  test('换了根不选', () => {
    expect(childToReselect(at('/root/docs', 'r1'), at('/root', 'r2'))).toBeNull();
  });
});

describe('cutPathsOf', () => {
  const clipboard: ExplorerClipboard = {
    mode: 'cut',
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'dev1',
    paths: ['/root/a.txt'],
  };

  test('只在产生剪切的节点 + 根上显示', () => {
    expect([...cutPathsOf(clipboard, 'self', 'r1')]).toEqual(['/root/a.txt']);
    expect(cutPathsOf(clipboard, 'self', 'r2').size).toBe(0);
    expect(cutPathsOf(clipboard, 'n2', 'r1').size).toBe(0);
  });

  test('复制态与空剪贴板没有剪切项，且返回同一个空集合', () => {
    const none = cutPathsOf(null, 'self', 'r1');
    expect(none.size).toBe(0);
    expect(cutPathsOf({ ...clipboard, mode: 'copy' }, 'self', 'r1')).toBe(none);
  });
});

describe('clipboardItems', () => {
  const clipboard = (paths: string[]): ExplorerClipboard => ({
    mode: 'copy',
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'dev1',
    paths,
  });

  test('名称取路径的最后一段', () => {
    expect(clipboardItems(clipboard(['/root/a.txt', '/root/docs']), []).names).toEqual([
      'a.txt',
      'docs',
    ]);
  });

  test('类型全部已知且都是文件 → 不含目录', () => {
    expect(clipboardItems(clipboard(['/root/a.txt', '/root/b.txt']), ENTRIES).hasDirectory).toBe(
      false
    );
  });

  test('含目录，或有一项不在已知列表里 → 按含目录处理', () => {
    expect(clipboardItems(clipboard(['/root/a.txt', '/root/docs']), ENTRIES).hasDirectory).toBe(
      true
    );
    expect(clipboardItems(clipboard(['/elsewhere/x.txt']), ENTRIES).hasDirectory).toBe(true);
  });
});

describe('listingNames', () => {
  test('完整列表给出名称集合', () => {
    expect(listingNames({ entries: ENTRIES, truncated: false })).toEqual(
      new Set(['docs', 'a.txt', 'b.txt', 'unknown.bin'])
    );
  });

  test('没有缓存或列表被截断时未知', () => {
    expect(listingNames(undefined)).toBeNull();
    expect(listingNames({ entries: ENTRIES, truncated: true })).toBeNull();
  });
});

describe('destDisplayName', () => {
  test('根目录用根的展示名，其余用目录名', () => {
    const root = { path: '/srv/app', name: '应用' };
    expect(destDisplayName('/srv/app', root)).toBe('应用');
    expect(destDisplayName('/srv/app/logs', root)).toBe('logs');
  });
});

describe('primaryEntry', () => {
  test('光标在选中项里取光标项，否则取第一项', () => {
    const selected = [ENTRIES[1], ENTRIES[2]];
    expect(primaryEntry(selected, '/root/b.txt')).toBe(ENTRIES[2]);
    expect(primaryEntry(selected, '/root/docs')).toBe(ENTRIES[1]);
    expect(primaryEntry(selected, null)).toBe(ENTRIES[1]);
    expect(primaryEntry([], '/root/a.txt')).toBeNull();
  });
});

describe('menuEntriesOf', () => {
  test('右键点在选中项上作用于整个选择，否则只作用于命中项', () => {
    const selected = [ENTRIES[1], ENTRIES[2]];
    expect(menuEntriesOf(ENTRIES[2], selected)).toBe(selected);
    expect(menuEntriesOf(ENTRIES[0], selected)).toEqual([ENTRIES[0]]);
  });
});

describe('contentKindOf', () => {
  const base = { loaded: true, failed: false, total: 0, visible: 0, hasPendingFolder: false };

  test('没有数据：请求失败是出错，否则加载中', () => {
    expect(contentKindOf({ ...base, loaded: false })).toBe('loading');
    expect(contentKindOf({ ...base, loaded: false, failed: true })).toBe('error');
  });

  test('已有数据时后台刷新失败不改变显示', () => {
    expect(contentKindOf({ ...base, failed: true, total: 2, visible: 2 })).toBe('view');
  });

  test('空目录、筛选无结果、正在新建文件夹', () => {
    expect(contentKindOf(base)).toBe('empty');
    expect(contentKindOf({ ...base, total: 3 })).toBe('filtered');
    expect(contentKindOf({ ...base, hasPendingFolder: true })).toBe('view');
  });
});
