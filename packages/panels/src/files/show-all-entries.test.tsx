// 「显示全部条目」这一位状态被提到根节点之上后的两个要求：
//   1) 目录节点因拖拽 chunk 落地而被重挂时，已点开的上限不能丢；
//   2) 撑开一个目录不能惊动其余目录（否则等于把之前逐行订阅的优化又还回去）。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShowAllEntriesProvider, createShowAllStore, useShowAllEntries } from './show-all-entries';

const A = 'root-a\nsrc';
const B = 'root-a\npkg';

describe('createShowAllStore', () => {
  test('目录节点重挂后仍读到已展开的上限', () => {
    const store = createShowAllStore();
    store.show(A);
    // 重挂＝一个全新的订阅者从头读快照；store 在 SortableVerticalList 之上，不受重挂波及
    expect(store.has(A)).toBe(true);
  });

  test('撑开一个目录不改变其余目录的快照', () => {
    const store = createShowAllStore();
    const before = store.has(B);
    store.show(A);
    expect(store.has(B)).toBe(before);
    expect(store.has(A)).toBe(true);
  });

  test('订阅者只在真的有变化时被唤醒', () => {
    const store = createShowAllStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.show(A);
    expect(notified).toBe(1);
    store.show(A);
    expect(notified).toBe(1);

    unsubscribe();
    store.show(B);
    expect(notified).toBe(1);
  });
});

describe('useShowAllEntries', () => {
  function Probe() {
    const { showAll } = useShowAllEntries(A);
    return <span data-show-all={showAll} />;
  }

  test('provider 下缺省为未展开', () => {
    const html = renderToStaticMarkup(
      <ShowAllEntriesProvider>
        <Probe />
      </ShowAllEntriesProvider>
    );
    expect(html).toContain('data-show-all="false"');
  });

  test('缺 provider 直接报错，避免悄悄退化成各自为政的局部状态', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ShowAllEntriesProvider/);
  });
});
