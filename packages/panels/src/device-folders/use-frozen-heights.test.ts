// 拖拽期间冻结容器高度的纯逻辑：冻的是第一次看到时的高度，撤销时还原原来的内联值。

import { describe, expect, test } from 'bun:test';
import { freezeHeights, releaseHeights } from './use-frozen-heights';

function element(offsetHeight: number, minHeight = '') {
  return { offsetHeight, style: { minHeight } };
}

describe('freezeHeights / releaseHeights', () => {
  test('把当前高度记成 min-height', () => {
    const tree = element(624);
    const grid = element(412);
    const held = new Map<ReturnType<typeof element>, string>();
    freezeHeights([tree, grid], held);
    expect(tree.style.minHeight).toBe('624px');
    expect(grid.style.minHeight).toBe('412px');
  });

  test('已经冻住的不重复量：回流让它变矮 / 变高都不改冻结值', () => {
    const grid = element(624);
    const held = new Map<ReturnType<typeof element>, string>();
    freezeHeights([grid], held);
    // 回流后少了一行（实际不会低于 min-height，这里模拟「如果重新量」会得到的值）
    grid.offsetHeight = 412;
    freezeHeights([grid], held);
    expect(grid.style.minHeight).toBe('624px');
    grid.offsetHeight = 836;
    freezeHeights([grid], held);
    expect(grid.style.minHeight).toBe('624px');
  });

  test('拖拽途中才挂载的网格按它第一次被看到时的高度补冻', () => {
    const tree = element(624);
    const held = new Map<ReturnType<typeof element>, string>();
    freezeHeights([tree], held);
    const expandedFolderGrid = element(200);
    freezeHeights([tree, expandedFolderGrid], held);
    expect(expandedFolderGrid.style.minHeight).toBe('200px');
    expect(tree.style.minHeight).toBe('624px');
  });

  test('撤销：还原原来的内联 min-height，并清空记录（下一次拖拽重新量）', () => {
    const plain = element(624);
    const styled = element(300, '10rem');
    const held = new Map<ReturnType<typeof element>, string>();
    freezeHeights([plain, styled], held);
    releaseHeights(held);
    expect(plain.style.minHeight).toBe('');
    expect(styled.style.minHeight).toBe('10rem');
    expect(held.size).toBe(0);

    plain.offsetHeight = 412;
    freezeHeights([plain], held);
    expect(plain.style.minHeight).toBe('412px');
  });
});
