// 侧边栏 mesh 分节的 memo 稳定性。
//
// 触发场景：mesh 每收到一次 `NODE_EVENT`（RTT 事件 10 s 一次、ping 15 s 一次）都会重建整份
// 节点数组与分节条目，dnd-kit 的 `useSortable` 又每渲染返回新的 style / 手柄 props——两者叠
// 加让 `memo(SidebarNodeRuntimeSection)` 100% 失效，整棵设备树跟着重渲染。
//
// bun test 无 DOM，跑不了「重渲染计数」；这里直接锁住决定 memo 是否 bail 的两个比较函数：
// 只要它们在「数据没变、对象换了」时返回 true，React 就不会重渲染子树。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { patchNodesWithEvent } = await import('@/node/mesh-nodes');
const { sameSortableRow, toSidebarEntries } = await import('./sidebar-device-list');
const { sameNodeEntry, sameRuntimeSectionProps } = await import('./sidebar-node-section');
const { nodeDeviceContext } = await import('@/pages/devices/node-device-group');

type SidebarNodeEntry = ReturnType<typeof toSidebarEntries>[number];
type SortableRow = Parameters<typeof sameSortableRow>[0];

function meshNode(overrides: Partial<MeshNode> = {}): MeshNode {
  return {
    id: 'node-a',
    name: '书房',
    online: true,
    loggedIn: true,
    reach: 'direct',
    transport: 'webrtc',
    rttMs: 12,
    inventory: null,
    ...overrides,
  } as MeshNode;
}

function entry(overrides: Partial<SidebarNodeEntry> = {}): SidebarNodeEntry {
  return {
    id: 'node-a',
    runtimeNodeId: 'node-a',
    name: '书房',
    online: true,
    loggedIn: true,
    isSelf: false,
    inventory: null,
    ...overrides,
  };
}

const SHARED_REFS = {
  setNodeRef: () => {},
  setDragHandleRef: () => {},
};

/** dnd-kit 的返回形状：每渲染新建 style 与 dragHandleProps 对象，内层值不变。 */
function sortableRow(overrides: Partial<SortableRow> = {}): SortableRow {
  return {
    setNodeRef: SHARED_REFS.setNodeRef,
    setDragHandleRef: SHARED_REFS.setDragHandleRef,
    style: { transform: undefined, transition: undefined },
    isDragging: false,
    dragHandleProps: {
      role: 'button',
      tabIndex: 0,
      'aria-disabled': false,
      'aria-pressed': undefined,
      'aria-roledescription': 'sortable',
      'aria-describedby': 'dnd-describedby-0',
    },
    ...overrides,
  } as SortableRow;
}

describe('sameNodeEntry', () => {
  test('字段相同但对象是新的：视为未变', () => {
    expect(sameNodeEntry(entry(), entry())).toBe(true);
  });

  test('渲染读到的每个字段变化都要判为已变', () => {
    const base = entry();
    expect(sameNodeEntry(base, entry({ id: 'node-b' }))).toBe(false);
    expect(sameNodeEntry(base, entry({ runtimeNodeId: 'node-b' }))).toBe(false);
    expect(sameNodeEntry(base, entry({ name: '客厅' }))).toBe(false);
    expect(sameNodeEntry(base, entry({ online: false }))).toBe(false);
    expect(sameNodeEntry(base, entry({ loggedIn: false }))).toBe(false);
    expect(sameNodeEntry(base, entry({ isSelf: true }))).toBe(false);
    expect(sameNodeEntry(base, entry({ inventory: { devices: [] } }))).toBe(false);
  });
});

describe('sameRuntimeSectionProps', () => {
  test('NODE_EVENT 只改了别的 node 时，本节的 props 判为未变', () => {
    const nodes = [meshNode(), meshNode({ id: 'node-b', name: '客厅' })];
    const before = toSidebarEntries(nodes, 'node-a');

    // RTT 事件：`patchNodesWithEvent` 无条件换掉命中的 node 对象，数组也跟着换引用
    const patched = patchNodesWithEvent(nodes, {
      nodeId: 'node-b',
      status: 'online',
      rttMs: 99,
    } as Parameters<typeof patchNodesWithEvent>[1]);
    const after = toSidebarEntries(patched, 'node-a');

    expect(after[0]).not.toBe(before[0]);
    const drag = { sortable: sortableRow(), dragHandleLabel: '拖动' };
    expect(sameRuntimeSectionProps({ node: before[0], drag }, { node: after[0], drag })).toBe(true);
  });

  test('本节自己的字段变了就必须重渲染', () => {
    const drag = { sortable: sortableRow(), dragHandleLabel: '拖动' };
    expect(
      sameRuntimeSectionProps(
        { node: entry(), drag },
        { node: entry({ name: '书房（新）' }), drag }
      )
    ).toBe(false);
  });

  test('拖拽接线或折叠开关换了引用就必须重渲染', () => {
    const node = entry();
    const dragA = { sortable: sortableRow(), dragHandleLabel: '拖动' };
    const dragB = { sortable: sortableRow(), dragHandleLabel: '拖动' };
    expect(sameRuntimeSectionProps({ node, drag: dragA }, { node, drag: dragB })).toBe(false);

    const disclosure = { expanded: true, onToggle: () => {} };
    expect(
      sameRuntimeSectionProps(
        { node, drag: dragA, disclosure },
        { node, drag: dragA, disclosure: { expanded: true, onToggle: () => {} } }
      )
    ).toBe(false);
    expect(
      sameRuntimeSectionProps({ node, drag: dragA, disclosure }, { node, drag: dragA, disclosure })
    ).toBe(true);
  });
});

describe('sameSortableRow', () => {
  test('未拖拽时每渲染新建的 style / 手柄 props 判为未变', () => {
    expect(sameSortableRow(sortableRow(), sortableRow())).toBe(true);
  });

  test('位移、拖拽态、手柄 props 任一变化都判为已变', () => {
    const base = sortableRow();
    const handleProps = base.dragHandleProps;
    expect(
      sameSortableRow(
        base,
        sortableRow({ style: { transform: 'translate3d(0,8px,0)', transition: undefined } })
      )
    ).toBe(false);
    expect(
      sameSortableRow(
        base,
        sortableRow({ style: { transform: undefined, transition: 'transform 200ms' } })
      )
    ).toBe(false);
    expect(sameSortableRow(base, sortableRow({ isDragging: true }))).toBe(false);
    expect(
      sameSortableRow(base, sortableRow({ dragHandleProps: { ...handleProps, tabIndex: -1 } }))
    ).toBe(false);
    expect(
      sameSortableRow(
        base,
        sortableRow({
          dragHandleProps: { role: 'button', tabIndex: 0 } as SortableRow['dragHandleProps'],
        })
      )
    ).toBe(false);
  });
});

describe('nodeDeviceContext', () => {
  test('只取三个字段：entry 换对象但这三个字段没变时输出相等', () => {
    expect(nodeDeviceContext({ runtimeNodeId: 'node-a', name: '书房', isSelf: false })).toEqual(
      nodeDeviceContext({ runtimeNodeId: 'node-a', name: '书房', isSelf: false })
    );
  });
});
