// 节点磁贴网格的列模型：设备数 → 跨度，以及跨度类在各列数下的截断。

import { describe, expect, test } from 'bun:test';
import {
  NODE_GRID_CLASS,
  NODE_GRID_CONTAINER_CLASS,
  NODE_GRID_MAX_COLUMNS,
  NODE_TILE_SPAN_CLASS,
  nodeTileSpan,
} from './node-grid';

describe('nodeTileSpan', () => {
  test('跨度 = 设备数，封顶为最大列数', () => {
    expect(nodeTileSpan(1)).toBe(1);
    expect(nodeTileSpan(2)).toBe(2);
    expect(nodeTileSpan(3)).toBe(3);
    expect(nodeTileSpan(4)).toBe(3);
    expect(nodeTileSpan(40)).toBe(NODE_GRID_MAX_COLUMNS);
  });

  test('没有设备 / 数不出来的按一列算', () => {
    expect(nodeTileSpan(0)).toBe(1);
    expect(nodeTileSpan(-2)).toBe(1);
    expect(nodeTileSpan(Number.NaN)).toBe(1);
    expect(nodeTileSpan(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('网格与跨度类', () => {
  const classes = (value: string) => value.split(' ');

  test('列数跟容器宽度走：一列起步，48rem 两列，80rem 三列', () => {
    expect(classes(NODE_GRID_CONTAINER_CLASS)).toContain('@container');
    expect(classes(NODE_GRID_CLASS)).toEqual(
      expect.arrayContaining([
        'grid',
        'grid-cols-1',
        '@[48rem]:grid-cols-2',
        '@[80rem]:grid-cols-3',
      ])
    );
    // 顺序不重排：不能出现 dense 回填
    expect(NODE_GRID_CLASS).not.toContain('dense');
  });

  test('单列时一律只占一格；两列时想占三格的也只占两格', () => {
    for (const size of [1, 2, 3] as const) {
      expect(classes(NODE_TILE_SPAN_CLASS[size])).toContain('col-span-1');
    }
    expect(classes(NODE_TILE_SPAN_CLASS[1])).toEqual(['col-span-1']);
    expect(classes(NODE_TILE_SPAN_CLASS[2])).toEqual(['col-span-1', '@[48rem]:col-span-2']);
    expect(classes(NODE_TILE_SPAN_CLASS[3])).toEqual([
      'col-span-1',
      '@[48rem]:col-span-2',
      '@[80rem]:col-span-3',
    ]);
  });

  test('full 独占整行，与列数无关', () => {
    expect(NODE_TILE_SPAN_CLASS.full).toBe('col-span-full');
  });
});
