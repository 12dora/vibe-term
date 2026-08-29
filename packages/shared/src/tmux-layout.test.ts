import { describe, expect, test } from 'bun:test';
import {
  type TmuxLayoutNode,
  collectLayoutLeaves,
  layoutLeafPaneId,
  parseWindowLayout,
} from './tmux-layout';

// 以下样本均由真实 tmux 生成（tmux -L … display-message '#{window_layout}'）

describe('parseWindowLayout', () => {
  test('单叶 window', () => {
    const parsed = parseWindowLayout('ba9d,208x62,0,0,0');
    expect(parsed).not.toBeNull();
    expect(parsed?.checksum).toBe('ba9d');
    expect(parsed?.root).toEqual({
      type: 'leaf',
      paneNumId: 0,
      width: 208,
      height: 62,
      x: 0,
      y: 0,
    });
  });

  test('水平两 pane（{} = row）', () => {
    const parsed = parseWindowLayout('7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}');
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    expect(root?.type).toBe('row');
    if (root?.type !== 'row') {
      return;
    }
    expect(root.width).toBe(208);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toEqual({
      type: 'leaf',
      paneNumId: 0,
      width: 104,
      height: 62,
      x: 0,
      y: 0,
    });
    expect(root.children[1]).toEqual({
      type: 'leaf',
      paneNumId: 1,
      width: 103,
      height: 62,
      x: 105,
      y: 0,
    });
  });

  test('嵌套 {[]}：右侧再垂直分割', () => {
    const parsed = parseWindowLayout(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}'
    );
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    if (root?.type !== 'row') {
      throw new Error('expected row root');
    }
    expect(root.children).toHaveLength(2);
    const right = root.children[1];
    if (right?.type !== 'column') {
      throw new Error('expected column child');
    }
    expect(right.x).toBe(105);
    expect(right.children).toHaveLength(2);
    expect(right.children[0]).toMatchObject({ type: 'leaf', paneNumId: 1, y: 0, height: 31 });
    expect(right.children[1]).toMatchObject({ type: 'leaf', paneNumId: 2, y: 32, height: 30 });
  });

  test('even-horizontal 三 pane', () => {
    const parsed = parseWindowLayout('8419,208x62,0,0{68x62,0,0,0,68x62,69,0,1,70x62,138,0,2}');
    expect(parsed).not.toBeNull();
    const root = parsed?.root;
    if (root?.type !== 'row') {
      throw new Error('expected row root');
    }
    expect(root.children).toHaveLength(3);
    expect(root.children.map((c) => (c.type === 'leaf' ? c.paneNumId : -1))).toEqual([0, 1, 2]);
  });

  test('大 pane 编号映射回 %id', () => {
    const parsed = parseWindowLayout('ba9d,208x62,0,0,42');
    const leaves = parsed ? collectLayoutLeaves(parsed.root) : [];
    expect(leaves).toHaveLength(1);
    expect(layoutLeafPaneId(leaves[0] as (typeof leaves)[0])).toBe('%42');
  });

  test('collectLayoutLeaves 按视觉顺序返回', () => {
    const parsed = parseWindowLayout(
      '5ee7,208x62,0,0{104x62,0,0,0,103x62,105,0[103x31,105,0,1,103x30,105,32,2]}'
    );
    const leaves = parsed ? collectLayoutLeaves(parsed.root) : [];
    expect(leaves.map((l) => l.paneNumId)).toEqual([0, 1, 2]);
  });

  describe('畸形输入返回 null', () => {
    const cases: [string, string][] = [
      ['空串', ''],
      ['缺 checksum', '208x62,0,0,0'],
      ['checksum 非 hex', 'zzzz,208x62,0,0,0'],
      ['checksum 长度错', 'ba9,208x62,0,0,0'],
      ['缺 pane id', 'ba9d,208x62,0,0'],
      ['尺寸缺 x', 'ba9d,20862,0,0,0'],
      ['括号不闭合', '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1'],
      ['括号不匹配', '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1]'],
      ['split 只有一个子节点', '7d1d,208x62,0,0{104x62,0,0,0}'],
      ['尾部有多余内容', 'ba9d,208x62,0,0,0garbage'],
      ['非数字字段', 'ba9d,ax62,0,0,0'],
    ];
    for (const [name, input] of cases) {
      test(name, () => {
        expect(parseWindowLayout(input)).toBeNull();
      });
    }
  });
});

// 表驱动：样本由真实 tmux 生成
// （tmux -L <独立 socket> list-windows -F '#{window_layout}'，208x62 窗口）
function describeNode(node: TmuxLayoutNode): string {
  const box = `${node.width}x${node.height}+${node.x}+${node.y}`;
  if (node.type === 'leaf') {
    return `%${node.paneNumId}:${box}`;
  }
  return `${node.type}(${box})[${node.children.map(describeNode).join(' ')}]`;
}

describe('parseWindowLayout 真实样本表', () => {
  const cases: { name: string; layout: string; shape: string; paneNumIds: number[] }[] = [
    {
      name: '单 pane',
      layout: 'ba9d,208x62,0,0,0',
      shape: '%0:208x62+0+0',
      paneNumIds: [0],
    },
    {
      name: '水平分割（split-window -h）',
      layout: '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}',
      shape: 'row(208x62+0+0)[%0:104x62+0+0 %1:103x62+105+0]',
      paneNumIds: [0, 1],
    },
    {
      name: '垂直分割（split-window -v）',
      layout: 'ded6,208x62,0,0[208x31,0,0,0,208x30,0,32,1]',
      shape: 'column(208x62+0+0)[%0:208x31+0+0 %1:208x30+0+32]',
      paneNumIds: [0, 1],
    },
    {
      name: '垂直里套水平',
      layout: '959b,208x62,0,0[208x31,0,0,0,208x30,0,32{104x30,0,32,1,103x30,105,32,2}]',
      shape: 'column(208x62+0+0)[%0:208x31+0+0 row(208x30+0+32)[%1:104x30+0+32 %2:103x30+105+32]]',
      paneNumIds: [0, 1, 2],
    },
    {
      name: '三层嵌套（带 x/y 偏移）',
      layout:
        'e35e,208x62,0,0[208x31,0,0{104x31,0,0,0,103x31,105,0,4},208x30,0,32{104x30,0,32,1,103x30,105,32[103x15,105,32,2,103x14,105,48,3]}]',
      shape:
        'column(208x62+0+0)[row(208x31+0+0)[%0:104x31+0+0 %4:103x31+105+0] row(208x30+0+32)[%1:104x30+0+32 column(103x30+105+32)[%2:103x15+105+32 %3:103x14+105+48]]]',
      paneNumIds: [0, 4, 1, 2, 3],
    },
    {
      name: 'tiled（split 与 leaf 混合子节点）',
      layout:
        'fbce,208x62,0,0[208x20,0,0{103x20,0,0,0,104x20,104,0,4},208x20,0,21{103x20,0,21,1,104x20,104,21,2},208x20,0,42,3]',
      shape:
        'column(208x62+0+0)[row(208x20+0+0)[%0:103x20+0+0 %4:104x20+104+0] row(208x20+0+21)[%1:103x20+0+21 %2:104x20+104+21] %3:208x20+0+42]',
      paneNumIds: [0, 4, 1, 2, 3],
    },
    {
      name: 'even-vertical 五 pane',
      layout:
        '79ef,208x62,0,0[208x12,0,0,0,208x12,0,13,4,208x12,0,26,1,208x11,0,39,2,208x11,0,51,3]',
      shape:
        'column(208x62+0+0)[%0:208x12+0+0 %4:208x12+0+13 %1:208x12+0+26 %2:208x11+0+39 %3:208x11+0+51]',
      paneNumIds: [0, 4, 1, 2, 3],
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const parsed = parseWindowLayout(item.layout);
      if (!parsed) {
        throw new Error(`failed to parse: ${item.layout}`);
      }
      expect(parsed.checksum).toBe(item.layout.slice(0, 4));
      expect(describeNode(parsed.root)).toBe(item.shape);
      expect(collectLayoutLeaves(parsed.root).map((leaf) => leaf.paneNumId)).toEqual(
        item.paneNumIds
      );
    });
  }
});

describe('parseWindowLayout 语法边界返回 null', () => {
  const cases: [string, string][] = [
    ['垂直括号不闭合', 'ded6,208x62,0,0[208x31,0,0,0,208x30,0,32,1'],
    ['垂直括号错配 }', 'ded6,208x62,0,0[208x31,0,0,0,208x30,0,32,1}'],
    ['垂直 split 只有一个子节点', 'ded6,208x62,0,0[208x31,0,0,0]'],
    ['空括号', 'ded6,208x62,0,0[]'],
    ['非法分隔符 ()', 'ba9d,208x62,0,0(104x62,0,0,0,103x62,105,0,1)'],
    ['子节点间多余逗号', '7d1d,208x62,0,0{104x62,0,0,0,,103x62,105,0,1}'],
    ['pane id 位置为空', 'ba9d,208x62,0,0,'],
    ['尺寸多出一段', 'ba9d,208x62x1,0,0,0'],
    ['多余闭括号', '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}}'],
    ['缺少 y 坐标', 'ba9d,208x62,0,0'],
    ['缺少宽度', 'ba9d,x62,0,0,0'],
    ['嵌套子节点畸形', '959b,208x62,0,0[208x31,0,0,0,208x30,0,32{104x30,0,32,1}]'],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      expect(parseWindowLayout(input)).toBeNull();
    });
  }
});
