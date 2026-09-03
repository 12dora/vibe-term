// 拖拽实现的懒加载边界：chunk 到位之前列表照常渲染（只是不可拖），到位之后换成真正的
// DndContext + useSortable。bun test 无 DOM，用 react-dom/server 静态渲染断言两种分支。
//
// 模块级缓存跨测试文件共享，跑完必须 reset，否则别的文件会随机看到「已加载」分支。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SortableVerticalList,
  loadDeviceTreeDnd,
  resetDeviceTreeDndForTests,
  useSortableRow,
} from './device-tree-dnd';

function Probe() {
  const row = useSortableRow('row-1');
  return (
    <div data-testid="probe" ref={row.setNodeRef} style={row.style} data-dragging={row.isDragging}>
      <button type="button" data-testid="handle" {...row.dragHandleProps}>
        handle
      </button>
    </div>
  );
}

function renderList(): string {
  return renderToStaticMarkup(
    <SortableVerticalList ids={['row-1']} onReorder={() => undefined}>
      <Probe />
    </SortableVerticalList>
  );
}

beforeEach(() => {
  resetDeviceTreeDndForTests();
});

afterAll(() => {
  resetDeviceTreeDndForTests();
});

describe('device-tree 拖拽懒加载', () => {
  test('实现未就位时照常渲染 children，只是没有拖拽绑定', () => {
    const html = renderList();
    expect(html).toContain('data-testid="probe"');
    expect(html).toContain('data-testid="handle"');
    // 空样板保留 role/tabIndex，加载前后焦点顺序与语义一致
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    // 说明节点还不存在，不能挂悬空的 aria-describedby
    expect(html).not.toContain('aria-describedby');
  });

  test('实现就位后换成真正的 dnd-kit 绑定', async () => {
    await loadDeviceTreeDnd();
    const html = renderList();
    expect(html).toContain('data-testid="probe"');
    expect(html).toContain('data-testid="handle"');
    expect(html).toContain('aria-describedby="DndDescribedBy-');
    expect(html).toContain('aria-roledescription="sortable"');
  });

  test('重复加载复用同一份实现', async () => {
    const first = await loadDeviceTreeDnd();
    const second = await loadDeviceTreeDnd();
    expect(second).toBe(first);
  });
});
