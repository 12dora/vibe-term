// useFileOps 里抽出来的纯逻辑；hook 本身（API + Toast + 缓存接线）不在这里渲染。

import { describe, expect, test } from 'bun:test';
import {
  expandedPathsUnder,
  isPathUnder,
  joinChildPath,
  parentDir,
  partitionDeleteResults,
  relocatedMoveItems,
  summarizeBatchFailure,
  touchedParentDirs,
} from './use-file-ops';

describe('parentDir / joinChildPath', () => {
  test('父目录', () => {
    expect(parentDir('/srv/a/b.txt')).toBe('/srv/a');
    expect(parentDir('/srv')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });

  test('拼子路径时根目录不产生双斜杠', () => {
    expect(joinChildPath('/srv/a', 'b')).toBe('/srv/a/b');
    expect(joinChildPath('/', 'b')).toBe('/b');
  });
});

describe('isPathUnder', () => {
  test('自身与后代算，同前缀的兄弟不算', () => {
    expect(isPathUnder('/srv/a', '/srv/a')).toBe(true);
    expect(isPathUnder('/srv/a/b/c', '/srv/a')).toBe(true);
    expect(isPathUnder('/srv/ab', '/srv/a')).toBe(false);
    expect(isPathUnder('/srv', '/srv/a')).toBe(false);
  });

  test('根目录之下是一切绝对路径', () => {
    expect(isPathUnder('/srv', '/')).toBe(true);
  });
});

describe('touchedParentDirs', () => {
  test('去重并保持首次出现的顺序', () => {
    expect(touchedParentDirs(['/srv/a/1', '/srv/b/2', '/srv/a/3', '/top'])).toEqual([
      '/srv/a',
      '/srv/b',
      '/',
    ]);
    expect(touchedParentDirs([])).toEqual([]);
  });
});

describe('partitionDeleteResults', () => {
  test('按 ok 分成已删路径与失败项', () => {
    const failed = { path: '/srv/b', ok: false, code: 'permission_denied' as const };
    expect(
      partitionDeleteResults([{ path: '/srv/a', ok: true }, failed, { path: '/srv/c', ok: true }])
    ).toEqual({ removed: ['/srv/a', '/srv/c'], failed: [failed] });
  });
});

describe('expandedPathsUnder', () => {
  test('只取该 root 下、位于目标路径（含自身）之下的展开键', () => {
    const keys = ['r1\n/srv/a', 'r1\n/srv/a/deep', 'r1\n/srv/ab', 'r2\n/srv/a', 'r1\n/srv'];
    expect(expandedPathsUnder(keys, 'r1', '/srv/a')).toEqual(['/srv/a', '/srv/a/deep']);
  });
});

describe('summarizeBatchFailure', () => {
  test('全部成功', () => {
    expect(summarizeBatchFailure([{ path: '/a', ok: true }])).toEqual({ kind: 'none' });
    expect(summarizeBatchFailure([])).toEqual({ kind: 'none' });
  });

  test('全部失败：带首项错误码', () => {
    expect(
      summarizeBatchFailure([
        { path: '/a', ok: false, code: 'not_found' },
        { path: '/b', ok: false, code: 'permission_denied' },
      ])
    ).toEqual({ kind: 'all', code: 'not_found' });
  });

  test('部分失败：只报数量', () => {
    expect(
      summarizeBatchFailure([
        { path: '/a', ok: true },
        { path: '/b', ok: false, code: 'permission_denied' },
        { path: '/c', ok: false },
      ])
    ).toEqual({ kind: 'partial', count: 2 });
  });
});

describe('relocatedMoveItems', () => {
  test('只保留成功且确实换了位置的项', () => {
    expect(
      relocatedMoveItems([
        { path: '/srv/a/x', ok: true, dest: '/srv/b/x' },
        { path: '/srv/b/y', ok: true, dest: '/srv/b/y' },
        { path: '/srv/a/z', ok: false, code: 'already_exists' },
        { path: '/srv/a/w', ok: true },
      ])
    ).toEqual([{ from: '/srv/a/x', to: '/srv/b/x' }]);
  });
});
