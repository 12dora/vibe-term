// 文件树逐行的选中态派生：路由一变就重渲染整棵树的根因是每行各自调 useLocation()，
// 改成「根节点读一次 + 逐行按自己那一位订阅」后，未受影响的行读到的快照必须逐帧同值
// （useSyncExternalStore 以 Object.is 比较快照，同值即不重渲染）。

import { describe, expect, test } from 'bun:test';
import {
  type SelectedFile,
  isFileSelected,
  selectedChildPath,
  selectedPathInRoot,
} from './selected-file';

const ROOT = 'root-a';

function rowSnapshots(selected: SelectedFile | null, paths: readonly string[]): boolean[] {
  return paths.map((path) => isFileSelected(selected, ROOT, path));
}

describe('isFileSelected', () => {
  test('只有 root 与 path 都命中才算选中', () => {
    const selected: SelectedFile = { rootId: ROOT, path: 'src/main.ts' };
    expect(isFileSelected(selected, ROOT, 'src/main.ts')).toBe(true);
    expect(isFileSelected(selected, ROOT, 'src/other.ts')).toBe(false);
    expect(isFileSelected(selected, 'root-b', 'src/main.ts')).toBe(false);
    expect(isFileSelected(null, ROOT, 'src/main.ts')).toBe(false);
  });

  test('与文件树无关的路由变化不改变任何一行的快照', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    // 切 tmux pane：两次都不是 /file/ 路由，选中态恒为 null
    const before = rowSnapshots(null, paths);
    const after = rowSnapshots(null, paths);
    expect(after).toEqual(before);
    expect(after.some(Boolean)).toBe(false);
  });

  test('换选中文件时只有两行的快照翻转', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    const before = rowSnapshots({ rootId: ROOT, path: 'src/file-7.ts' }, paths);
    const after = rowSnapshots({ rootId: ROOT, path: 'src/file-123.ts' }, paths);

    const flipped = paths.filter((_, index) => before[index] !== after[index]);
    expect(flipped).toEqual(['src/file-7.ts', 'src/file-123.ts']);
  });
});

describe('selectedPathInRoot', () => {
  test('只对选中文件所在的根给出路径', () => {
    const selected: SelectedFile = { rootId: ROOT, path: 'deep/file.ts' };
    expect(selectedPathInRoot(selected, ROOT)).toBe('deep/file.ts');
    expect(selectedPathInRoot(selected, 'root-b')).toBeNull();
    expect(selectedPathInRoot(null, ROOT)).toBeNull();
  });

  test('别的根下换选中文件时本根快照不变', () => {
    const first = selectedPathInRoot({ rootId: 'root-b', path: 'a.ts' }, ROOT);
    const second = selectedPathInRoot({ rootId: 'root-b', path: 'b.ts' }, ROOT);
    expect(first).toBeNull();
    expect(second).toBe(first);
  });
});

// 目录节点只用「选中文件是不是自己的直接子项」撑开显示上限。按整根的选中路径订阅时，
// 同一个根下换文件会让这个根里所有已挂载的目录节点快照都变一遍，白白重渲染。
describe('selectedChildPath', () => {
  test('只认直接子项，孙子与旁支都不算', () => {
    const selected: SelectedFile = { rootId: ROOT, path: '/w/src/a.ts' };
    expect(selectedChildPath(selected, ROOT, '/w/src')).toBe('/w/src/a.ts');
    expect(selectedChildPath(selected, ROOT, '/w')).toBeNull();
    expect(selectedChildPath(selected, ROOT, '/w/src/deep')).toBeNull();
    expect(selectedChildPath(selected, ROOT, '/w/other')).toBeNull();
    expect(selectedChildPath(selected, 'root-b', '/w/src')).toBeNull();
    expect(selectedChildPath(null, ROOT, '/w/src')).toBeNull();
  });

  test('根目录 / 与末尾多余分隔符都能正确比较', () => {
    const selected: SelectedFile = { rootId: ROOT, path: '/etc' };
    expect(selectedChildPath(selected, ROOT, '/')).toBe('/etc');
    expect(selectedChildPath({ rootId: ROOT, path: '/w/a.ts' }, ROOT, '/w/')).toBe('/w/a.ts');
  });

  test('同目录内换文件：只有该目录的快照变，其余目录逐帧同值', () => {
    const dirs = ['/w', '/w/src', '/w/src/deep', '/w/pkg', '/w/pkg/nested'];
    const before = dirs.map((dir) =>
      selectedChildPath({ rootId: ROOT, path: '/w/src/a.ts' }, ROOT, dir)
    );
    const after = dirs.map((dir) =>
      selectedChildPath({ rootId: ROOT, path: '/w/src/b.ts' }, ROOT, dir)
    );

    const changed = dirs.filter((_, i) => !Object.is(before[i], after[i]));
    expect(changed).toEqual(['/w/src']);
  });

  test('跨目录换文件：只有得失选中子项的那两个目录快照变', () => {
    const dirs = ['/w', '/w/src', '/w/src/deep', '/w/pkg', '/w/pkg/nested'];
    const before = dirs.map((dir) =>
      selectedChildPath({ rootId: ROOT, path: '/w/src/a.ts' }, ROOT, dir)
    );
    const after = dirs.map((dir) =>
      selectedChildPath({ rootId: ROOT, path: '/w/pkg/b.ts' }, ROOT, dir)
    );

    const changed = dirs.filter((_, i) => !Object.is(before[i], after[i]));
    expect(changed).toEqual(['/w/src', '/w/pkg']);
  });
});
