import { describe, expect, test } from 'bun:test';
import type { FileEntryDto } from '@vibeterm/shared';
import {
  createTransferPaneState,
  moveHighlight,
  parentPath,
  pickerIndex,
  pruneSelection,
  rangeSelection,
  sendBlock,
  toggleSelection,
  transferBreadcrumbs,
  transferPaneReducer,
  visibleEntries,
} from './pane-state';

function entry(name: string, type: FileEntryDto['type'] = 'file'): FileEntryDto {
  return {
    name,
    path: `/root/${name}`,
    type,
    category: type === 'dir' ? 'directory' : 'text',
    size: type === 'dir' ? null : 10,
    modifiedAt: null,
    isSymlink: false,
  };
}

describe('选择 helper', () => {
  test('toggle 加选与取消', () => {
    const once = toggleSelection(new Set<string>(), '/a');
    expect([...once]).toEqual(['/a']);
    expect([...toggleSelection(once, '/a')]).toEqual([]);
  });

  test('shift 区间双向都覆盖，且不取消已选项', () => {
    const paths = ['/a', '/b', '/c', '/d'];
    expect([...rangeSelection(new Set(['/d']), paths, 0, 2)].sort()).toEqual([
      '/a',
      '/b',
      '/c',
      '/d',
    ]);
    expect([...rangeSelection(new Set<string>(), paths, 3, 1)].sort()).toEqual(['/b', '/c', '/d']);
  });

  test('prune 摘掉不在列表里的路径，无变化时返回原引用', () => {
    const selection = new Set(['/a', '/x']);
    expect([...pruneSelection(selection, ['/a', '/b'])]).toEqual(['/a']);
    const stable = new Set(['/a']);
    expect(pruneSelection(stable, ['/a', '/b'])).toBe(stable);
  });

  test('高亮移动按边界夹紧', () => {
    expect(moveHighlight(0, -1, 1)).toBe(-1);
    expect(moveHighlight(3, -1, 1)).toBe(0);
    expect(moveHighlight(3, 2, 1)).toBe(2);
    expect(moveHighlight(3, 0, -1)).toBe(0);
  });
});

describe('transferPaneReducer', () => {
  const base = createTransferPaneState('self');

  test('换节点整块重置，换同一个节点返回原引用', () => {
    const withRoot = transferPaneReducer(base, { type: 'selectRoot', rootId: 'r1' });
    expect(transferPaneReducer(withRoot, { type: 'selectNode', nodeId: 'self' })).toBe(withRoot);
    const other = transferPaneReducer(withRoot, { type: 'selectNode', nodeId: 'n2' });
    expect(other.rootId).toBeNull();
    expect(other.nodeId).toBe('n2');
  });

  test('换根目录保留隐藏文件开关，清掉路径与选择', () => {
    let state = transferPaneReducer(base, { type: 'toggleHidden', hidden: true });
    state = transferPaneReducer(state, { type: 'selectRoot', rootId: 'r1' });
    state = transferPaneReducer(state, { type: 'navigate', path: '/root/sub' });
    state = transferPaneReducer(state, { type: 'toggle', index: 0, path: '/root/sub/a' });
    const next = transferPaneReducer(state, { type: 'selectRoot', rootId: 'r2' });
    expect(next.hidden).toBe(true);
    expect(next.path).toBe('');
    expect(next.selection.size).toBe(0);
  });

  test('进目录清掉选择与高亮，并同步路径输入框', () => {
    let state = transferPaneReducer(base, { type: 'toggle', index: 1, path: '/root/a' });
    state = transferPaneReducer(state, { type: 'navigate', path: '/root/sub' });
    expect(state.selection.size).toBe(0);
    expect(state.highlight).toBe(-1);
    expect(state.draft).toBe('/root/sub');
  });

  test('路径输入框只接受绝对路径', () => {
    let state = transferPaneReducer(base, { type: 'draft', value: 'relative' });
    expect(transferPaneReducer(state, { type: 'submitDraft' })).toBe(state);
    state = transferPaneReducer(state, { type: 'draft', value: '  /abs  ' });
    expect(transferPaneReducer(state, { type: 'submitDraft' }).path).toBe('/abs');
  });

  test('sync 只在服务端解析出的路径不同时才换引用', () => {
    const synced = transferPaneReducer(base, { type: 'sync', path: '/root' });
    expect(synced.path).toBe('/root');
    expect(transferPaneReducer(synced, { type: 'sync', path: '/root' })).toBe(synced);
  });

  test('shift 点选以上一次 toggle 为锚点', () => {
    const paths = ['/a', '/b', '/c'];
    let state = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/a' });
    state = transferPaneReducer(state, { type: 'range', index: 2, paths });
    expect([...state.selection].sort()).toEqual(['/a', '/b', '/c']);
  });

  test('锚点按路径记，列表过滤后仍指向同一个条目', () => {
    // 显示隐藏文件时列表是 ['/.a', '/b', '/c', '/d']，隐藏后只剩下面三条
    const visible = ['/b', '/c', '/d'];
    // 显示隐藏文件时勾上 /c（下标 2）
    let state = transferPaneReducer(base, { type: 'toggle', index: 2, path: '/c' });
    expect(state.anchorPath).toBe('/c');
    // 隐藏 .a 之后 /c 变成下标 1；对下标 0 的 /b 做 shift 点选只应覆盖 /b–/c
    state = transferPaneReducer(state, { type: 'prune', paths: visible });
    state = transferPaneReducer(state, { type: 'range', index: 0, paths: visible });
    expect([...state.selection].sort()).toEqual(['/b', '/c']);
  });

  test('锚点条目消失后 shift 点选退回单选', () => {
    let state = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/gone' });
    state = transferPaneReducer(state, { type: 'prune', paths: ['/a', '/b'] });
    expect(state.anchorPath).toBeNull();
    state = transferPaneReducer(state, { type: 'range', index: 1, paths: ['/a', '/b'] });
    expect([...state.selection]).toEqual(['/b']);
  });

  test('列表变动后高亮按路径重新对上，条目没了就取消高亮', () => {
    let state = transferPaneReducer(base, { type: 'move', delta: 1, paths: ['/a', '/b', '/c'] });
    state = transferPaneReducer(state, { type: 'move', delta: 1, paths: ['/a', '/b', '/c'] });
    expect(state.highlight).toBe(1);
    expect(state.highlightPath).toBe('/b');

    const shifted = transferPaneReducer(state, { type: 'prune', paths: ['/b', '/c'] });
    expect(shifted.highlight).toBe(0);

    const dropped = transferPaneReducer(state, { type: 'prune', paths: ['/a', '/c'] });
    expect(dropped.highlight).toBe(-1);
    expect(dropped.highlightPath).toBeNull();
  });

  test('内容没变化的 prune 返回原引用', () => {
    const state = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/a' });
    expect(transferPaneReducer(state, { type: 'prune', paths: ['/a', '/b'] })).toBe(state);
  });

  test('revision 随节点 / 目录 / 选择变化递增，光标移动不算', () => {
    const picked = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/a' });
    expect(picked.revision).toBe(base.revision + 1);
    const moved = transferPaneReducer(picked, { type: 'move', delta: 1, paths: ['/a', '/b'] });
    expect(moved.revision).toBe(picked.revision);
    const switched = transferPaneReducer(moved, { type: 'selectNode', nodeId: 'n2' });
    expect(switched.revision).toBe(picked.revision + 1);
  });

  test('迟到的清空只在 revision 未变时生效', () => {
    const submitted = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/a' });
    // 提交后用户又勾了一个
    const changed = transferPaneReducer(submitted, { type: 'toggle', index: 1, path: '/b' });
    const stale = transferPaneReducer(changed, {
      type: 'clearSelection',
      revision: submitted.revision,
    });
    expect(stale).toBe(changed);
    expect(stale.selection.size).toBe(2);

    const fresh = transferPaneReducer(changed, {
      type: 'clearSelection',
      revision: changed.revision,
    });
    expect(fresh.selection.size).toBe(0);
  });

  test('不带 revision 的清空一律生效', () => {
    const state = transferPaneReducer(base, { type: 'toggle', index: 0, path: '/a' });
    expect(transferPaneReducer(state, { type: 'clearSelection' }).selection.size).toBe(0);
  });

  test('highlight 动作同步记下路径，重复设置返回原引用', () => {
    const paths = ['/a', '/b'];
    const state = transferPaneReducer(base, { type: 'highlight', index: 1, paths });
    expect(state.highlightPath).toBe('/b');
    expect(transferPaneReducer(state, { type: 'highlight', index: 1, paths })).toBe(state);
  });
});

describe('pickerIndex', () => {
  test('解析行下标；非法值为 null', () => {
    expect(pickerIndex('3')).toBe(3);
    expect(pickerIndex('0')).toBe(0);
    expect(pickerIndex('-1')).toBeNull();
    expect(pickerIndex('x')).toBeNull();
    expect(pickerIndex(null)).toBeNull();
    expect(pickerIndex(undefined)).toBeNull();
  });
});

describe('列表整理', () => {
  test('隐藏文件默认过滤，目录在前', () => {
    const entries = [entry('b.txt'), entry('.env'), entry('adir', 'dir')];
    expect(visibleEntries(entries, false).map((item) => item.name)).toEqual(['adir', 'b.txt']);
    expect(visibleEntries(entries, true).map((item) => item.name)).toEqual([
      'adir',
      '.env',
      'b.txt',
    ]);
  });

  test('上一级与面包屑', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBeNull();
    expect(parentPath('')).toBeNull();
    expect(transferBreadcrumbs('/a/b').map((crumb) => crumb.path)).toEqual(['/', '/a', '/a/b']);
    expect(transferBreadcrumbs('')).toEqual([]);
  });
});

describe('sendBlock', () => {
  function pane(overrides: Partial<ReturnType<typeof createTransferPaneState>>) {
    return { ...createTransferPaneState('self'), rootId: 'r1', path: '/root', ...overrides };
  }

  test('两侧未选全时不可发送', () => {
    expect(sendBlock(pane({ rootId: null }), pane({}))).toBe('incomplete');
    expect(sendBlock(pane({}), pane({ path: '' }))).toBe('incomplete');
  });

  test('源没有勾选时不可发送', () => {
    expect(sendBlock(pane({}), pane({ rootId: 'r2' }))).toBe('noSelection');
  });

  test('同节点同根同路径时不可发送，换个目录就可以', () => {
    const source = pane({ selection: new Set(['/root/a']) });
    expect(sendBlock(source, pane({}))).toBe('sameLocation');
    expect(sendBlock(source, pane({ path: '/root/sub' }))).toBeNull();
    expect(sendBlock(source, pane({ rootId: 'r2' }))).toBeNull();
  });
});
