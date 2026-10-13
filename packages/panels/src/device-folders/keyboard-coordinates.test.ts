// 键盘方向键的选站：按行模型而不是四角距离。布局用评审复现用的三列网格。

import { describe, expect, test } from 'bun:test';
import type { CollisionTile } from './collision';
import { ROOT_CONTAINER_ID, bodyDropZoneId, dropZoneId } from './folder-tree-model';
import { type ArrowDirection, keyboardStops, nextKeyboardStop } from './keyboard-coordinates';

const COLUMN = 406;
const GAP = 12;
const HEIGHT = 200;
const WIDTH = 3 * COLUMN + 2 * GAP;

function tile(id: string, column: number, row: number, span = 1): CollisionTile {
  const left = column * (COLUMN + GAP);
  const top = row * (HEIGHT + GAP);
  const width = span * COLUMN + (span - 1) * GAP;
  return {
    id,
    rect: { left, top, width, height: HEIGHT, right: left + width, bottom: top + HEIGHT },
  };
}

/** 三列：第 1 行 A B（第 3 列空着），第 2 行 F 跨三列，第 3 行 C D */
const STOPS: CollisionTile[] = [
  tile('A', 0, 0),
  tile('B', 1, 0),
  tile('F', 0, 1, 3),
  tile('C', 0, 2),
  tile('D', 1, 2),
];

function rectOf(id: string) {
  const stop = STOPS.find((candidate) => candidate.id === id);
  if (!stop) throw new Error(`没有这一站：${id}`);
  return stop.rect;
}

/** 预览卡片的左上角对在 `from` 的左上角，按一次方向键 */
function press(from: string, direction: ArrowDirection, stops = STOPS): string | null {
  const { left, top } = rectOf(from);
  return nextKeyboardStop({ direction, origin: { left, top }, overId: from }, stops)?.id ?? null;
}

describe('nextKeyboardStop · 宽窄混排', () => {
  test('↓ / ↑ 不会跳过整行宽的磁贴', () => {
    expect(press('A', 'down')).toBe('F');
    expect(press('B', 'down')).toBe('F');
    expect(press('F', 'down')).toBe('C');
    expect(press('C', 'up')).toBe('F');
    expect(press('D', 'up')).toBe('F');
    expect(press('F', 'up')).toBe('A');
  });

  test('↓ / ↑ 在目标行里取水平范围包含预览卡片左边缘的那块', () => {
    // 预览卡片左边缘在第 2 列：下一行取 D 而不是 C
    const origin = { left: COLUMN + GAP, top: HEIGHT + GAP };
    const down = nextKeyboardStop({ direction: 'down', origin, overId: 'F' }, STOPS);
    expect(down?.id).toBe('D');
    const up = nextKeyboardStop({ direction: 'up', origin, overId: 'F' }, STOPS);
    expect(up?.id).toBe('B');
  });

  test('目标行里没有包含它的：取水平最近的', () => {
    // 第 3 列下面没有磁贴（C D 只占前两列）→ 取最近的 D
    const third = tile('E', 2, 0);
    const stops = [...STOPS, third];
    expect(
      nextKeyboardStop({ direction: 'down', origin: third.rect, overId: 'E' }, stops)?.id
    ).toBe('F');
    const origin = { left: 2 * (COLUMN + GAP), top: HEIGHT + GAP + 40 };
    const withoutWide = stops.filter((stop) => stop.id !== 'F');
    expect(nextKeyboardStop({ direction: 'down', origin, overId: null }, withoutWide)?.id).toBe(
      'D'
    );
  });

  test('→ / ← 按阅读顺序走，行尾接下一行行首', () => {
    expect(press('A', 'right')).toBe('B');
    expect(press('B', 'right')).toBe('F');
    expect(press('F', 'right')).toBe('C');
    expect(press('C', 'right')).toBe('D');
    expect(press('D', 'left')).toBe('C');
    expect(press('C', 'left')).toBe('F');
    expect(press('F', 'left')).toBe('B');
    expect(press('B', 'left')).toBe('A');
  });

  test('那个方向没有可去的地方：返回 null（预览卡片不动）', () => {
    expect(press('A', 'up')).toBeNull();
    expect(press('A', 'left')).toBeNull();
    expect(press('D', 'down')).toBeNull();
    expect(press('D', 'right')).toBeNull();
  });

  test('亚像素对不齐也认得出当前所在的行', () => {
    const { left, top } = rectOf('B');
    const origin = { left: left - 0.4, top: top + 0.3 };
    expect(nextKeyboardStop({ direction: 'down', origin, overId: 'B' }, STOPS)?.id).toBe('F');
    expect(nextKeyboardStop({ direction: 'right', origin, overId: 'B' }, STOPS)?.id).toBe('F');
  });
});

describe('nextKeyboardStop · 预览卡片没压着任何一站（跨容器：底下是占位条）', () => {
  // 占位条占了第 1 行第 2 列，B 被挤到第 3 列；预览卡片停在占位条的左上角，当前落点是 B
  const stops: CollisionTile[] = [tile('A', 0, 0), tile('B', 2, 0), tile('C', 0, 1)];
  const origin = { left: COLUMN + GAP, top: 0 };

  test('→ 跳过当前落点（它就在卡片后面，再选它等于没动）', () => {
    expect(nextKeyboardStop({ direction: 'right', origin, overId: 'B' }, stops)?.id).toBe('C');
    // 当前落点不是它时照常取下一个
    expect(nextKeyboardStop({ direction: 'right', origin, overId: null }, stops)?.id).toBe('B');
  });

  test('← 取卡片之前的那一个；↓ 取下一行', () => {
    expect(nextKeyboardStop({ direction: 'left', origin, overId: 'B' }, stops)?.id).toBe('A');
    expect(nextKeyboardStop({ direction: 'down', origin, overId: 'B' }, stops)?.id).toBe('C');
    expect(nextKeyboardStop({ direction: 'up', origin, overId: 'B' }, stops)).toBeNull();
  });
});

describe('keyboardStops', () => {
  const rootZone = dropZoneId(ROOT_CONTAINER_ID);
  const rect = (top: number, bottom: number, left = 0, right = WIDTH) => ({
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  });
  const source = (id: string, containerId?: string) => ({
    id,
    data: { current: containerId ? { containerId } : {} },
  });
  /** 分组 a（头 0..30，里面 n1、n2）、空分组 b（头 + 空内容区）、整棵树 0..600 */
  const containers = [
    source(rootZone),
    source('folder:a', ROOT_CONTAINER_ID),
    source(dropZoneId('folder:a')),
    source('node:n1', 'folder:a'),
    source('node:n2', 'folder:a'),
    source('folder:b', ROOT_CONTAINER_ID),
    source(dropZoneId('folder:b')),
    source(bodyDropZoneId('folder:b')),
  ];
  const rects = new Map<string | number, ReturnType<typeof rect>>([
    [rootZone, rect(0, 600)],
    ['folder:a', rect(0, 250)],
    [dropZoneId('folder:a'), rect(0, 30)],
    ['node:n1', rect(40, 240, 10, 400)],
    ['node:n2', rect(40, 240, 420, 810)],
    ['folder:b', rect(270, 340)],
    [dropZoneId('folder:b'), rect(270, 300)],
    [bodyDropZoneId('folder:b'), rect(305, 335)],
  ]);
  const ids = (stops: CollisionTile[]) => stops.map((stop) => stop.id);

  test('拖节点：节点磁贴（含自己的原位）、分组头、空分组内容区；分组本体不是一站', () => {
    const stops = keyboardStops(source('node:n1', 'folder:a'), containers, rects);
    expect(ids(stops)).toEqual(
      expect.arrayContaining([
        'node:n1',
        'node:n2',
        dropZoneId('folder:a'),
        dropZoneId('folder:b'),
        bodyDropZoneId('folder:b'),
      ])
    );
    expect(ids(stops)).not.toContain('folder:a');
  });

  test('节点在分组里且根层没有磁贴：加一站树底部的窄带（移到最外层）', () => {
    const stops = keyboardStops(source('node:n1', 'folder:a'), containers, rects);
    const strip = stops.find((stop) => stop.id === rootZone);
    expect(strip?.rect.bottom).toBe(600);
    expect(strip?.rect.height).toBeLessThan(100);
  });

  test('根层有磁贴 / 被拖节点本来就在根层：不加窄带', () => {
    const withRootTile = [...containers, source('node:r1', ROOT_CONTAINER_ID)];
    const withRect = new Map(rects).set('node:r1', rect(360, 560, 0, 400));
    expect(ids(keyboardStops(source('node:n1', 'folder:a'), withRootTile, withRect))).not.toContain(
      rootZone
    );
    expect(
      ids(keyboardStops(source('node:r1', ROOT_CONTAINER_ID), withRootTile, withRect))
    ).not.toContain(rootZone);
  });

  test('拖分组：只有分组本体是站（头落点区与本体重叠，不重复算）', () => {
    const stops = keyboardStops(source('folder:a', ROOT_CONTAINER_ID), containers, rects);
    expect(ids(stops).sort()).toEqual(['folder:a', 'folder:b']);
  });

  test('量不到矩形的条目不是站', () => {
    const partial = new Map(rects);
    partial.delete('node:n2');
    expect(ids(keyboardStops(source('node:n1', 'folder:a'), containers, partial))).not.toContain(
      'node:n2'
    );
  });
});
