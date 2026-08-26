// createRenderState 的分配失败路径：任一 handle 分配抛错时，已创建的 handle 必须按
// 逆序释放，否则 WASM 侧对象泄漏（进程内无法回收）。
import { describe, expect, test } from 'bun:test';
import type { GhosttyBindings } from './ghostty-wasm';
import { createRenderState } from './render-state';

type HandleEvent = { kind: 'create' | 'free'; what: string; handle: number };

function createFakeBindings(failAt: 'state' | 'iterator' | 'cells' | null) {
  const events: HandleEvent[] = [];
  const bindings = {
    createRenderState: () => {
      if (failAt === 'state') {
        throw new Error('render state alloc failed');
      }
      events.push({ kind: 'create', what: 'state', handle: 11 });
      return 11;
    },
    createRenderStateRowIterator: () => {
      if (failAt === 'iterator') {
        throw new Error('row iterator alloc failed');
      }
      events.push({ kind: 'create', what: 'iterator', handle: 22 });
      return 22;
    },
    createRenderStateRowCells: () => {
      if (failAt === 'cells') {
        throw new Error('row cells alloc failed');
      }
      events.push({ kind: 'create', what: 'cells', handle: 33 });
      return 33;
    },
    freeRenderState: (handle: number) => {
      events.push({ kind: 'free', what: 'state', handle });
    },
    freeRenderStateRowIterator: (handle: number) => {
      events.push({ kind: 'free', what: 'iterator', handle });
    },
    freeRenderStateRowCells: (handle: number) => {
      events.push({ kind: 'free', what: 'cells', handle });
    },
  };

  return { bindings: bindings as unknown as GhosttyBindings, events };
}

function outstanding(events: HandleEvent[]): string[] {
  const live = new Map<string, number>();
  for (const event of events) {
    live.set(event.what, (live.get(event.what) ?? 0) + (event.kind === 'create' ? 1 : -1));
  }

  return [...live.entries()].filter(([, count]) => count > 0).map(([what]) => what);
}

describe('createRenderState 分配失败不泄漏 handle', () => {
  test('全部成功时按序返回三个 handle', () => {
    const { bindings, events } = createFakeBindings(null);
    const resources = createRenderState(bindings);

    expect(resources.renderStateHandle).toBe(11);
    expect(resources.rowIteratorHandle).toBe(22);
    expect(resources.rowCellsHandle).toBe(33);
    expect(resources.disposed).toBeFalse();
    expect(events.filter((event) => event.kind === 'free')).toHaveLength(0);
  });

  test('row iterator 分配抛错时释放已创建的 render state', () => {
    const { bindings, events } = createFakeBindings('iterator');

    expect(() => createRenderState(bindings)).toThrow('row iterator alloc failed');
    expect(outstanding(events)).toEqual([]);
    expect(events).toEqual([
      { kind: 'create', what: 'state', handle: 11 },
      { kind: 'free', what: 'state', handle: 11 },
    ]);
  });

  test('row cells 分配抛错时按逆序释放 iterator 与 render state', () => {
    const { bindings, events } = createFakeBindings('cells');

    expect(() => createRenderState(bindings)).toThrow('row cells alloc failed');
    expect(outstanding(events)).toEqual([]);
    expect(events.filter((event) => event.kind === 'free').map((event) => event.what)).toEqual([
      'iterator',
      'state',
    ]);
  });

  test('首个分配即抛错时不产生任何释放调用', () => {
    const { bindings, events } = createFakeBindings('state');

    expect(() => createRenderState(bindings)).toThrow('render state alloc failed');
    expect(events).toHaveLength(0);
  });
});
