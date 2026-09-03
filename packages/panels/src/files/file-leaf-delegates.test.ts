// 共享右键菜单的事件委托：500 行只有一个 Trigger，靠事件目标反查是哪一行。
// panels 的测试环境没有 DOM，这里用 `AttrElement` 的替身搭一棵结构相同的假树。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@tmex/shared';
import {
  FILE_LEAF_LONG_PRESS_MOVE_PX,
  FILE_LEAF_LONG_PRESS_MS,
  type LeafHit,
  createLongPress,
  hitFileLeaf,
  markOpenRow,
  shouldArmLongPress,
} from './file-leaf-delegates';
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

describe('shouldArmLongPress', () => {
  test('单指命中文件行才武装长按', () => {
    const hit = hitFileLeaf(rows[7], [ROOT], lookup);
    expect(shouldArmLongPress(hit, 1)).toBe(true);
  });

  test('多指 / 零指不是长按手势', () => {
    const hit = hitFileLeaf(rows[7], [ROOT], lookup);
    expect(shouldArmLongPress(hit, 2)).toBe(false);
    expect(shouldArmLongPress(hit, 0)).toBe(false);
  });

  test('未命中文件行（填充行 / 空白处）不武装，手势完整留给浏览器', () => {
    expect(shouldArmLongPress(null, 1)).toBe(false);
  });
});

/** 手动时钟：只跑到点的定时器 */
function manualSchedule() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    schedule: (run: () => void, ms: number) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    unschedule: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
    armed: () => timers.size,
  };
}

describe('createLongPress', () => {
  function setup() {
    const clock = manualSchedule();
    const fired: { payload: LeafHit; x: number; y: number }[] = [];
    const tracker = createLongPress<LeafHit>({
      onFire: (payload, point) => fired.push({ payload, x: point.clientX, y: point.clientY }),
      schedule: clock.schedule,
      unschedule: clock.unschedule,
    });
    return { clock, fired, tracker };
  }

  const hit = (index: number): LeafHit => hitFileLeaf(rows[index], [ROOT], lookup) as LeafHit;

  test('按住 500 ms 才触发，并带回按下时的坐标与命中行', () => {
    const { clock, fired, tracker } = setup();
    tracker.start(hit(3), { clientX: 40, clientY: 90 });

    clock.advance(FILE_LEAF_LONG_PRESS_MS - 1);
    expect(fired).toEqual([]);

    clock.advance(1);
    expect(fired.length).toBe(1);
    expect(fired[0]?.payload.target.entry).toBe(entries[3]);
    expect(fired[0]?.x).toBe(40);
    expect(fired[0]?.y).toBe(90);
  });

  test('位移超过 10 px 即取消（滚动不弹菜单）；阈值内不取消', () => {
    const within = setup();
    within.tracker.start(hit(1), { clientX: 0, clientY: 0 });
    within.tracker.move({ clientX: FILE_LEAF_LONG_PRESS_MOVE_PX, clientY: 0 });
    within.clock.advance(FILE_LEAF_LONG_PRESS_MS);
    expect(within.fired.length).toBe(1);

    const beyond = setup();
    beyond.tracker.start(hit(1), { clientX: 0, clientY: 0 });
    beyond.tracker.move({ clientX: 0, clientY: FILE_LEAF_LONG_PRESS_MOVE_PX + 1 });
    expect(beyond.clock.armed()).toBe(0);
    beyond.clock.advance(FILE_LEAF_LONG_PRESS_MS);
    expect(beyond.fired).toEqual([]);
  });

  test('抬指 / 取消后不再触发，定时器也不留着', () => {
    const { clock, fired, tracker } = setup();
    tracker.start(hit(2), { clientX: 5, clientY: 5 });
    tracker.cancel();
    expect(clock.armed()).toBe(0);
    clock.advance(FILE_LEAF_LONG_PRESS_MS * 3);
    expect(fired).toEqual([]);
  });

  test('触发过一次才需要在抬指时抑制合成 mouse 序列，且只抑制一次', () => {
    const { clock, tracker } = setup();
    tracker.start(hit(4), { clientX: 1, clientY: 1 });
    expect(tracker.consumeFired()).toBe(false);

    clock.advance(FILE_LEAF_LONG_PRESS_MS);
    expect(tracker.consumeFired()).toBe(true);
    expect(tracker.consumeFired()).toBe(false);
  });

  test('重新按下会顶掉上一次的定时器，只触发一次', () => {
    const { clock, fired, tracker } = setup();
    tracker.start(hit(0), { clientX: 0, clientY: 0 });
    clock.advance(FILE_LEAF_LONG_PRESS_MS - 10);
    tracker.start(hit(1), { clientX: 0, clientY: 0 });
    expect(clock.armed()).toBe(1);
    clock.advance(FILE_LEAF_LONG_PRESS_MS);
    expect(fired.length).toBe(1);
    expect(fired[0]?.payload.target.entry).toBe(entries[1]);
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
