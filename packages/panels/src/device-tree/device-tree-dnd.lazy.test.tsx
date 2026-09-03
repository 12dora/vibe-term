// 拖拽实现的懒加载边界：chunk 到位之前列表照常渲染（只是不可拖），到位之后换成真正的
// DndContext + useSortable。bun test 无 DOM，用 react-dom/server 静态渲染断言两种分支。
//
// 模块级缓存跨测试文件共享，跑完必须 reset，否则别的文件会随机看到「已加载」分支。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAX_DND_AUTO_RETRIES,
  SortableVerticalList,
  deviceTreeDndLoadStateForTests,
  dndRetryDelayMs,
  loadDeviceTreeDnd,
  requestDeviceTreeDnd,
  resetDeviceTreeDndForTests,
  setDeviceTreeDndImporterForTests,
  useSortableRow,
} from './device-tree-dnd';

/** 让 import() 的 then 链走完 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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

// 加载失败后的恢复：常驻侧栏一次失败若不重试，整个页面生命周期内拖拽都是死的。
describe('device-tree 拖拽加载失败恢复', () => {
  test('退避时长指数增长且封顶 30s', () => {
    expect(dndRetryDelayMs(1)).toBe(800);
    expect(dndRetryDelayMs(2)).toBe(1600);
    expect(dndRetryDelayMs(3)).toBe(3200);
    expect(dndRetryDelayMs(20)).toBe(30_000);
  });

  test('失败后记一次并排一次退避重试，而不是就此躺平', async () => {
    setDeviceTreeDndImporterForTests(() => Promise.reject(new Error('chunk 404')));
    requestDeviceTreeDnd();
    await flushMicrotasks();

    const state = deviceTreeDndLoadStateForTests();
    expect(state.loaded).toBe(false);
    expect(state.failures).toBe(1);
    expect(state.retryScheduled).toBe(true);
  });

  test('自动重试次数封顶，不在离线时空转', async () => {
    setDeviceTreeDndImporterForTests(() => Promise.reject(new Error('chunk 404')));
    for (let i = 0; i <= MAX_DND_AUTO_RETRIES + 1; i += 1) {
      requestDeviceTreeDnd();
      await flushMicrotasks();
    }
    const state = deviceTreeDndLoadStateForTests();
    expect(state.failures).toBeGreaterThan(MAX_DND_AUTO_RETRIES);
    expect(state.retryScheduled).toBe(false);
  });

  test('失败后再次请求会重新发起 import，成功即清零失败计数', async () => {
    let calls = 0;
    setDeviceTreeDndImporterForTests(async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk 404');
      return await import('./device-tree-dnd-impl');
    });

    requestDeviceTreeDnd();
    await flushMicrotasks();
    expect(deviceTreeDndLoadStateForTests().failures).toBe(1);

    requestDeviceTreeDnd();
    await flushMicrotasks();
    const state = deviceTreeDndLoadStateForTests();
    expect(state.loaded).toBe(true);
    expect(state.failures).toBe(0);
    expect(state.retryScheduled).toBe(false);
    expect(calls).toBe(2);
  });

  test('空样板的拖拽手柄带上了「碰一下就重试」的钩子', async () => {
    setDeviceTreeDndImporterForTests(() => Promise.reject(new Error('chunk 404')));
    let handleProps: Record<string, unknown> | null = null;
    function CaptureProbe() {
      const row = useSortableRow('row-1');
      handleProps = row.dragHandleProps as unknown as Record<string, unknown>;
      return null;
    }
    renderToStaticMarkup(
      <SortableVerticalList ids={['row-1']} onReorder={() => undefined}>
        <CaptureProbe />
      </SortableVerticalList>
    );

    const props = handleProps as unknown as Record<string, unknown>;
    expect(typeof props.onPointerDown).toBe('function');
    expect(typeof props.onKeyDown).toBe('function');

    // 用户真的去碰手柄：立刻再试一次，不必等退避到期
    (props.onPointerDown as () => void)();
    await flushMicrotasks();
    expect(deviceTreeDndLoadStateForTests().failures).toBe(1);
  });
});
