// 共享右键菜单的事件委托：500 行只有一个 Trigger，靠事件目标反查是哪一行。
// panels 的测试环境没有 DOM，这里用 `AttrElement` 的替身搭一棵结构相同的假树。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@tmex/shared';
import { armFileLeafMenu, hitFileLeaf, markOpenRow } from './file-leaf-delegates';
import {
  type AttrElement,
  FILE_LEAF_PATH_ATTR,
  FILE_LIST_DIR_ATTR,
  FILE_LIST_ROOT_ATTR,
} from './file-leaf-target';

const ROOT: FileRootDto = {
  id: 'r-local',
  deviceId: 'd-local',
  deviceName: '书房',
  deviceType: 'local',
  path: '/srv/local',
  name: 'local',
  enabled: true,
  sortOrder: 0,
};

interface FakeElement extends AttrElement {
  attrs: Record<string, string>;
  parent: FakeElement | null;
}

function fake(attrs: Record<string, string>, parent: FakeElement | null = null): FakeElement {
  const node: FakeElement = {
    attrs,
    parent,
    getAttribute: (name) => node.attrs[name] ?? null,
    closest: (selector) => {
      const name = selector.slice(1, -1);
      let cursor: FakeElement | null = node;
      while (cursor) {
        if (name in cursor.attrs) return cursor;
        cursor = cursor.parent;
      }
      return null;
    },
  };
  return node;
}

function fileEntry(index: number): FileEntryDto {
  return {
    name: `f${index}.txt`,
    path: `${ROOT.path}/f${index}.txt`,
    type: 'file',
    category: 'text',
    size: index,
    modifiedAt: null,
    isSymlink: false,
  };
}

const dirEntry: FileEntryDto = {
  name: 'sub',
  path: `${ROOT.path}/sub`,
  type: 'dir',
  category: 'directory',
  size: null,
  modifiedAt: null,
  isSymlink: false,
};

const entries = [...Array.from({ length: 500 }, (_, i) => fileEntry(i)), dirEntry];
const listing: ListFilesResponse = { path: ROOT.path, entries, truncated: false };
const lookup = (rootId: string, dir: string): ListFilesResponse | undefined =>
  rootId === ROOT.id && dir === ROOT.path ? listing : undefined;

const listEl = fake({ [FILE_LIST_ROOT_ATTR]: ROOT.id, [FILE_LIST_DIR_ATTR]: ROOT.path });
const rows = entries.map((entry) => fake({ [FILE_LEAF_PATH_ATTR]: entry.path }, listEl));
// 行内的图标 / 文件名 span：事件目标常常是它们而不是按钮本身
const rowInner = rows.map((row) => fake({}, row));

describe('hitFileLeaf', () => {
  test('落在第 N 行（含行内元素）上就解析出第 N 行的 entry 与所属根', () => {
    for (const index of [0, 1, 249, 499]) {
      expect(hitFileLeaf(rows[index], [ROOT], lookup)?.target.entry).toBe(entries[index]);
      expect(hitFileLeaf(rowInner[index], [ROOT], lookup)?.target.entry).toBe(entries[index]);
      expect(hitFileLeaf(rows[index], [ROOT], lookup)?.target.root).toBe(ROOT);
      expect(hitFileLeaf(rows[index], [ROOT], lookup)?.row).toBe(rows[index]);
    }
  });

  test('不在文件行内（列表容器本身、树外元素、非元素目标）一律 null', () => {
    expect(hitFileLeaf(listEl, [ROOT], lookup)).toBeNull();
    expect(hitFileLeaf(fake({}), [ROOT], lookup)).toBeNull();
    expect(hitFileLeaf(null, [ROOT], lookup)).toBeNull();
    expect(hitFileLeaf({ nope: true }, [ROOT], lookup)).toBeNull();
  });

  test('目录行不当文件行处理（目录有自己的菜单）', () => {
    const dirRow = fake({ [FILE_LEAF_PATH_ATTR]: dirEntry.path }, listEl);
    expect(hitFileLeaf(dirRow, [ROOT], lookup)).toBeNull();
  });

  test('根已不可见、或该目录的列表缓存已失效时不解析出目标', () => {
    expect(hitFileLeaf(rows[0], [], lookup)).toBeNull();
    expect(hitFileLeaf(rows[0], [ROOT], () => undefined)).toBeNull();
  });

  test('缓存里已没有这一项（刚被删掉）时不解析出目标', () => {
    const shrunk: ListFilesResponse = {
      path: ROOT.path,
      entries: entries.slice(1),
      truncated: false,
    };
    expect(hitFileLeaf(rows[0], [ROOT], () => shrunk)).toBeNull();
  });
});

describe('armFileLeafMenu', () => {
  const counter = () => {
    let count = 0;
    return {
      prevent: () => {
        count += 1;
      },
      get: () => count,
    };
  };

  test('鼠标右键命中文件行：放行给 base-ui 的 Trigger', () => {
    const c = counter();
    const hit = hitFileLeaf(rows[3], [ROOT], lookup);
    expect(armFileLeafMenu(hit, undefined, c.prevent)).toBe(hit);
    expect(c.get()).toBe(0);
  });

  test('右键落在填充行（「显示其余」/空目录提示）上：挡掉，不弹上一次的菜单', () => {
    const c = counter();
    expect(armFileLeafMenu(null, undefined, c.prevent)).toBeNull();
    expect(c.get()).toBe(1);
  });

  test('单指长按命中文件行放行；多指一律挡掉', () => {
    const hit = hitFileLeaf(rows[7], [ROOT], lookup);
    const single = counter();
    expect(armFileLeafMenu(hit, 1, single.prevent)).toBe(hit);
    expect(single.get()).toBe(0);

    const multi = counter();
    expect(armFileLeafMenu(hit, 2, multi.prevent)).toBeNull();
    expect(multi.get()).toBe(1);

    const zero = counter();
    expect(armFileLeafMenu(hit, 0, zero.prevent)).toBeNull();
    expect(zero.get()).toBe(1);
  });
});

describe('markOpenRow', () => {
  test('打开时补上 data-popup-open / data-pressed，关闭时摘掉', () => {
    const attrs: Record<string, string> = {};
    const row = {
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      removeAttribute: (name: string) => {
        delete attrs[name];
      },
    };
    markOpenRow(row, true);
    expect(attrs).toEqual({ 'data-popup-open': '', 'data-pressed': '' });
    markOpenRow(row, false);
    expect(attrs).toEqual({});
  });

  test('没有命中过任何行时不炸', () => {
    expect(() => markOpenRow(null, true)).not.toThrow();
    expect(() => markOpenRow({}, false)).not.toThrow();
  });
});
