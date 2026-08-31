import { describe, expect, test } from 'bun:test';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { FileRootDto } from '@tmex/shared';
import {
  FILE_ROOTS_QUERY_KEY,
  fileRootOrderToSubmit,
  fileRootReorderOptions,
  nextFileRootOrder,
  reorderFileRootsOptimistically,
} from './root-reorder';

function root(id: string, sortOrder: number): FileRootDto {
  return {
    id,
    deviceId: 'd-1',
    deviceName: '本机',
    deviceType: 'local',
    path: `/srv/${id}`,
    name: id,
    enabled: true,
    sortOrder,
  };
}

const ALL = [root('a', 0), root('b', 1), root('c', 2), root('d', 3)];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function cachedIds(queryClient: QueryClient): string[] {
  const data = queryClient.getQueryData<{ roots: FileRootDto[] }>(FILE_ROOTS_QUERY_KEY);
  return (data?.roots ?? []).map((item) => item.id);
}

describe('nextFileRootOrder', () => {
  test('可见项按新顺序回填到它们原来的位置，隐藏项原地不动', () => {
    // 可见的是 a / c / d（b 被过滤掉），把 d 拖到最前
    expect(nextFileRootOrder(ALL, ['a', 'c', 'd'], ['d', 'a', 'c'])).toEqual(['d', 'b', 'a', 'c']);
  });

  test('全部可见时即新顺序本身', () => {
    expect(nextFileRootOrder(ALL, ['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'c'])).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });

  test('列表刚变动、完整顺序里还没有的可见项补在末尾', () => {
    expect(nextFileRootOrder([root('a', 0)], ['a', 'z'], ['z', 'a'])).toEqual(['z', 'a']);
  });
});

describe('fileRootOrderToSubmit', () => {
  test('空闲时给出完整顺序', () => {
    expect(fileRootOrderToSubmit(ALL, ['a', 'c', 'd'], ['d', 'a', 'c'], false)).toEqual([
      'd',
      'b',
      'a',
      'c',
    ]);
  });

  test('上一次重排还在飞时不受理，返回 null', () => {
    expect(fileRootOrderToSubmit(ALL, ['a', 'c', 'd'], ['d', 'a', 'c'], true)).toBeNull();
  });
});

describe('reorderFileRootsOptimistically', () => {
  test('按提交顺序重排并重写 sortOrder，未列出的根保持相对顺序追加在后', () => {
    const next = reorderFileRootsOptimistically(ALL, ['c', 'a']);
    expect(next.map((item) => item.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(next.slice(0, 2).map((item) => item.sortOrder)).toEqual([0, 1]);
  });
});

describe('fileRootReorderOptions', () => {
  function setup() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(FILE_ROOTS_QUERY_KEY, { roots: ALL });
    const submitted: string[][] = [];
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const inflight = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    let failed = 0;
    const observer = new MutationObserver(
      queryClient,
      fileRootReorderOptions({
        queryClient,
        submit: (rootIds) => {
          submitted.push(rootIds);
          return inflight;
        },
        onFailed: () => {
          failed += 1;
        },
      })
    );
    return { queryClient, observer, submitted, settle, failedCount: () => failed };
  }

  test('提交期间先乐观改写缓存，失败后回滚并提示一次', async () => {
    const { queryClient, observer, submitted, settle, failedCount } = setup();

    const done = observer.mutate(['d', 'c', 'b', 'a']).catch(() => undefined);
    await flush();

    expect(submitted).toEqual([['d', 'c', 'b', 'a']]);
    expect(cachedIds(queryClient)).toEqual(['d', 'c', 'b', 'a']);

    settle.reject(new Error('boom'));
    await done;
    await flush();

    expect(cachedIds(queryClient)).toEqual(['a', 'b', 'c', 'd']);
    expect(failedCount()).toBe(1);
  });

  test('提交在飞期间 isPending 为真，拖拽结果因此不再受理第二次提交', async () => {
    const { observer, submitted, settle } = setup();

    const done = observer.mutate(['d', 'c', 'b', 'a']).catch(() => undefined);
    await flush();

    const pending = observer.getCurrentResult().isPending;
    expect(pending).toBe(true);
    expect(fileRootOrderToSubmit(ALL, ['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd'], pending)).toBe(
      null
    );

    settle.resolve();
    await done;
    await flush();

    expect(submitted).toHaveLength(1);
    expect(observer.getCurrentResult().isPending).toBe(false);
  });
});
