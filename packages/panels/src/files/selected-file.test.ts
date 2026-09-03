// 文件树逐行的选中态派生：路由一变就重渲染整棵树的根因是每行各自调 useLocation()，
// 改成「根节点读一次 + 逐行按自己那一位订阅」后，未受影响的行读到的快照必须逐帧同值
// （useSyncExternalStore 以 Object.is 比较快照，同值即不重渲染）。

import { describe, expect, test } from 'bun:test';
import { type SelectedFile, isFileSelected, selectedPathInRoot } from './selected-file';

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
